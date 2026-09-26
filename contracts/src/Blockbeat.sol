// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title Blockbeat — a 16-step sequencer clocked by Monad blocks.
/// @notice Every block is one step. A `hit` toggles one note bit in the step word of the
///         block it lands in. Sessions are finalized into an ERC-721 whose metadata and
///         16×8 grid image live fully onchain. Every tip pays 20 % to the session host and
///         80 % to the players' pool, split pro rata by hits among HUMAN players (the
///         resident DJ agent co-owns the track but takes no tips).
/// @dev No owner, no fees, no pausing, no upgradeability. See docs/SDD.md §4.2.
contract Blockbeat is ERC721 {
    using Strings for uint256;

    // ------------------------------------------------------------------ constants

    uint256 public constant STEPS = 16;
    uint256 public constant TRACKS = 8;
    uint256 public constant NOTES_PER_TRACK = 32;

    /// @notice Share of every tip paid to the session host, in basis points (20 %).
    uint256 public constant HOST_TIP_BPS = 2000;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // ------------------------------------------------------------------ types

    struct Session {
        uint64 startBlock;
        address host;
        bool finalized;
        uint64 hitCount; // total hits in the session (attribution denominator)
        uint256 tokenId; // 0 until finalized
        uint256 parentSessionId; // 0 for an original, else the remixed session
        uint256 tipPool; // players' pool: 80 % of each tip, claimable pro rata by human hits
    }

    /// @dev Storage layout of a session. `Session` above is the public (ABI) view, kept
    ///      unchanged for existing clients. `humanHitCount` and `hostTips` pack into the
    ///      `hitCount` slot, which `hit` and `tip` already touch, so neither pays for a new
    ///      storage slot (Monad charges the fixed gas limit, so every slot matters).
    struct SessionData {
        uint64 startBlock;
        address host;
        bool finalized;
        uint64 hitCount; // every hit, the agent's included (pattern and NFT attribution)
        uint64 humanHitCount; // hits by everyone except `agent` (tip-split denominator)
        uint128 hostTips; // host share earned, claimed or not (2^128 wei is far above supply)
        uint256 tokenId;
        uint256 parentSessionId;
        uint256 tipPool;
    }

    // ------------------------------------------------------------------ events

    event SessionStarted(
        uint256 indexed sessionId, uint64 startBlock, address indexed host, uint256 indexed parentSessionId
    );
    event Hit(
        uint256 indexed sessionId,
        address indexed player,
        uint64 blockNumber,
        uint8 step,
        uint8 track,
        uint8 note,
        bool on
    );
    event Tipped(uint256 indexed sessionId, address indexed from, uint256 amount);
    event Finalized(uint256 indexed sessionId, uint256 indexed tokenId, uint256 contributors);
    event Claimed(uint256 indexed sessionId, address indexed player, uint256 amount);
    /// @notice Emitted with every `Tipped`: how the tip was divided between host and pool.
    event TipSplit(uint256 indexed sessionId, uint256 hostAmount, uint256 poolAmount);
    event HostClaimed(uint256 indexed sessionId, address indexed host, uint256 amount);

    // ------------------------------------------------------------------ errors

    error SessionNotFound();
    error SessionFinalized();
    error SessionNotFinalized();
    error TrackOutOfRange();
    error NoteOutOfRange();
    error BlockBeforeStart();
    error NotHost();
    error ZeroTip();
    error NoHits();
    error NothingToClaim();
    error TransferFailed();
    error ZeroAgent();

    // ------------------------------------------------------------------ storage

    /// @dev Sessions and tokens are 1-based so that 0 means "none" for parents and tokens.
    uint256 private _sessionCount;
    uint256 private _tokenCount;

    /// @notice The resident DJ agent. Its hits shape the pattern and make it a contributor,
    ///         but never count for (or claim from) the players' pool.
    address public immutable agent;

    mapping(uint256 sessionId => SessionData) private _sessions;
    mapping(uint256 sessionId => uint256[16]) private _steps;
    mapping(uint256 sessionId => mapping(address player => uint64)) private _hits;
    mapping(uint256 sessionId => mapping(address player => uint256)) private _claimed;
    mapping(uint256 sessionId => address[]) private _contributors;
    mapping(uint256 sessionId => uint256) private _hostClaimed;

    mapping(uint256 tokenId => uint256[16]) private _tokenPatterns;
    mapping(uint256 tokenId => uint256) private _tokenSessions;

    constructor(address agent_) ERC721("Blockbeat Track", "BEAT") {
        if (agent_ == address(0)) revert ZeroAgent();
        agent = agent_;
    }

    // ------------------------------------------------------------------ writes

    /// @notice Start a new, empty session hosted by the caller. Step 0 is the current block.
    function startSession() external returns (uint256 sessionId) {
        sessionId = _createSession(0);
    }

    /// @notice Fork a finalized session: the 16 step words are copied and the parent recorded.
    function remix(uint256 parentSessionId) external returns (uint256 sessionId) {
        SessionData storage parent = _sessions[parentSessionId];
        if (parent.host == address(0)) revert SessionNotFound();
        if (!parent.finalized) revert SessionNotFinalized();

        sessionId = _createSession(parentSessionId);
        _steps[sessionId] = _steps[parentSessionId];
    }

    /// @notice Toggle note `note` of track `track` on the step derived from the current block.
    /// @dev The step is `(block.number - startBlock) % 16`; the caller never chooses it.
    ///      No external calls. One word SSTORE per hit, plus the attribution counters and a
    ///      contributors push on a player's first hit.
    function hit(uint256 sessionId, uint8 track, uint8 note) external {
        SessionData storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        if (s.finalized) revert SessionFinalized();
        if (track >= TRACKS) revert TrackOutOfRange();
        if (note >= NOTES_PER_TRACK) revert NoteOutOfRange();

        // block.number is the sequencer clock by design, not a source of randomness, and
        // the result is < 16 so the cast to uint8 cannot truncate.
        // forge-lint: disable-next-line(weak-prng, unsafe-typecast)
        uint8 step = uint8((block.number - s.startBlock) % STEPS);
        uint256 mask = uint256(1) << (uint256(track) * NOTES_PER_TRACK + uint256(note));
        uint256 word = _steps[sessionId][step] ^ mask;
        _steps[sessionId][step] = word;

        s.hitCount += 1;
        if (msg.sender != agent) s.humanHitCount += 1;
        uint64 playerHits = _hits[sessionId][msg.sender];
        _hits[sessionId][msg.sender] = playerHits + 1;
        if (playerHits == 0) _contributors[sessionId].push(msg.sender);

        // Block numbers fit in uint64 for any realistic chain lifetime (2^64 blocks at
        // 300 ms is ~175 billion years).
        // forge-lint: disable-next-line(unsafe-typecast)
        emit Hit(sessionId, msg.sender, uint64(block.number), step, track, note, word & mask != 0);
    }

    /// @notice Tip a session. Allowed before and after finalize. `HOST_TIP_BPS` (20 %) goes
    ///         to the host, the rest to the players' pool, split pro rata by human hits.
    /// @dev Rejected while the session has no hits (the UI waits for the first note). If only
    ///      the agent has played, the whole tip goes to the host: the pool always has a
    ///      human claimant (`humanHitCount` never decreases), so no wei can be stranded.
    ///      Pure accounting, no external call: the host is paid by pull (`claimHost`), so a
    ///      host that rejects ether cannot block tips and tippers' fixed gas limits hold.
    function tip(uint256 sessionId) external payable {
        SessionData storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        if (msg.value == 0) revert ZeroTip();
        if (s.hitCount == 0) revert NoHits();

        uint256 hostAmount =
            s.humanHitCount == 0 ? msg.value : (msg.value * HOST_TIP_BPS) / BPS_DENOMINATOR;
        uint256 poolAmount = msg.value - hostAmount;
        s.hostTips += SafeCast.toUint128(hostAmount);
        s.tipPool += poolAmount;
        emit Tipped(sessionId, msg.sender, msg.value);
        emit TipSplit(sessionId, hostAmount, poolAmount);
    }

    /// @notice Finalize a session (host only, once): freezes the pattern and mints the track
    ///         NFT to the host. The token stores its own copy of the 16 pattern words.
    function finalize(uint256 sessionId) external returns (uint256 tokenId) {
        SessionData storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        if (msg.sender != s.host) revert NotHost();
        if (s.finalized) revert SessionFinalized();

        // Effects.
        tokenId = ++_tokenCount;
        s.finalized = true;
        s.tokenId = tokenId;
        _tokenPatterns[tokenId] = _steps[sessionId];
        _tokenSessions[tokenId] = sessionId;
        emit Finalized(sessionId, tokenId, _contributors[sessionId].length);

        // Interaction (last). `_safeMint` may call back into a contract host via
        // onERC721Received; every state change above is already committed (CEI).
        _safeMint(msg.sender, tokenId);
    }

    /// @notice Pull the caller's share of the players' pool: `tipPool * hits / humanHitCount`
    ///         minus what was already claimed. Only after finalize, so the denominator is
    ///         frozen and the sum of all shares can never exceed `tipPool`. The agent has no
    ///         share (`NothingToClaim`).
    function claim(uint256 sessionId) external {
        SessionData storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        if (!s.finalized) revert SessionNotFinalized();
        uint64 playerHits = _hits[sessionId][msg.sender];
        if (playerHits == 0) revert NoHits();
        if (msg.sender == agent) revert NothingToClaim();

        // A human with hits implies humanHitCount >= playerHits > 0.
        uint256 share = (s.tipPool * playerHits) / s.humanHitCount;
        uint256 already = _claimed[sessionId][msg.sender];
        if (share <= already) revert NothingToClaim();
        uint256 amount = share - already;

        // Effects before interaction.
        _claimed[sessionId][msg.sender] = share;
        emit Claimed(sessionId, msg.sender, amount);

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Pull the host's share of the tips (20 % of each, or 100 % of a tip that came
    ///         while only the agent had played). Host only; allowed any time, since the host
    ///         share is fixed when each tip lands.
    function claimHost(uint256 sessionId) external {
        SessionData storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        if (msg.sender != s.host) revert NotHost();
        uint256 earned = s.hostTips;
        uint256 already = _hostClaimed[sessionId];
        if (earned <= already) revert NothingToClaim();
        uint256 amount = earned - already;

        // Effects before interaction.
        _hostClaimed[sessionId] = earned;
        emit HostClaimed(sessionId, msg.sender, amount);

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ------------------------------------------------------------------ reads

    /// @notice The 16 step words of a session (zeros for an unknown session).
    function pattern(uint256 sessionId) external view returns (uint256[16] memory) {
        return _steps[sessionId];
    }

    /// @notice The step a given block number maps to in a session.
    function stepOf(uint256 sessionId, uint64 blockNumber) external view returns (uint8) {
        SessionData storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        if (blockNumber < s.startBlock) revert BlockBeforeStart();
        // Result is < 16, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8((uint256(blockNumber) - s.startBlock) % STEPS);
    }

    /// @notice The session. `tipPool` is the players' pool only (80 % of tips); the total
    ///         tipped is `totalTipsOf`, the host's part `hostTipsOf`.
    function getSession(uint256 sessionId) external view returns (Session memory) {
        SessionData storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        return Session({
            startBlock: s.startBlock,
            host: s.host,
            finalized: s.finalized,
            hitCount: s.hitCount,
            tokenId: s.tokenId,
            parentSessionId: s.parentSessionId,
            tipPool: s.tipPool
        });
    }

    /// @notice Hits by everyone except the agent: the players' pool denominator.
    function humanHitCountOf(uint256 sessionId) external view returns (uint64) {
        return _sessions[sessionId].humanHitCount;
    }

    /// @notice Wei the host has earned from tips in this session (claimed or not).
    function hostTipsOf(uint256 sessionId) external view returns (uint256) {
        return _sessions[sessionId].hostTips;
    }

    /// @notice Wei the host could claim right now with `claimHost`.
    function hostClaimableOf(uint256 sessionId) external view returns (uint256) {
        return _sessions[sessionId].hostTips - _hostClaimed[sessionId];
    }

    /// @notice Every wei tipped to the session: host share plus players' pool.
    function totalTipsOf(uint256 sessionId) external view returns (uint256) {
        SessionData storage s = _sessions[sessionId];
        return s.hostTips + s.tipPool;
    }

    function hitsOf(uint256 sessionId, address player) external view returns (uint64) {
        return _hits[sessionId][player];
    }

    /// @notice Every address that hit the session, in first-hit order.
    /// @dev Best-effort, unbounded copy for `eth_call` only: ~2.1k gas per contributor, so a
    ///      500-player session reads in ~1.3M gas. Anyone can grow the list with fresh
    ///      addresses; if it ever exceeds a node's call gas cap, page with
    ///      `contributorCount` + `contributorsSlice` instead. Nothing onchain iterates it.
    function contributorsOf(uint256 sessionId) external view returns (address[] memory) {
        return _contributors[sessionId];
    }

    /// @notice Number of distinct players that hit the session.
    function contributorCount(uint256 sessionId) external view returns (uint256) {
        return _contributors[sessionId].length;
    }

    /// @notice Bounded page of contributors: `limit` entries from `offset`, clamped to the end.
    function contributorsSlice(uint256 sessionId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page)
    {
        address[] storage all = _contributors[sessionId];
        uint256 total = all.length;
        if (offset >= total) return page;
        uint256 remaining = total - offset;
        uint256 end = limit < remaining ? offset + limit : total;
        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = all[i];
        }
    }

    /// @notice Wei the player could claim right now (0 while the session is live, and
    ///         always 0 for the agent).
    function claimableOf(uint256 sessionId, address player) external view returns (uint256) {
        SessionData storage s = _sessions[sessionId];
        if (!s.finalized) return 0;
        uint64 playerHits = _hits[sessionId][player];
        if (playerHits == 0 || player == agent) return 0;
        uint256 share = (s.tipPool * playerHits) / s.humanHitCount;
        uint256 already = _claimed[sessionId][player];
        return share > already ? share - already : 0;
    }

    /// @notice Number of sessions created so far (ids run from 1 to this value).
    function sessionCount() external view returns (uint256) {
        return _sessionCount;
    }

    /// @notice The 16 pattern words frozen into a token at finalize.
    function tokenPattern(uint256 tokenId) external view returns (uint256[16] memory) {
        _requireOwned(tokenId);
        return _tokenPatterns[tokenId];
    }

    /// @notice The session a token was minted from.
    function tokenSession(uint256 tokenId) external view returns (uint256) {
        _requireOwned(tokenId);
        return _tokenSessions[tokenId];
    }

    /// @inheritdoc ERC721
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        uint256 sessionId = _tokenSessions[tokenId];
        SessionData storage s = _sessions[sessionId];

        string memory json = string.concat(
            '{"name":"Blockbeat Track #',
            tokenId.toString(),
            '","description":"A 16-step loop composed live by the room on Monad. Every column is a block, every note is a transaction.",',
            '"image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(_renderSvg(_tokenPatterns[tokenId]))),
            '","attributes":[',
            _attribute("hits", uint256(s.hitCount)),
            ",",
            _attribute("contributors", _contributors[sessionId].length),
            ",",
            _attribute("parent", s.parentSessionId),
            ",",
            _attribute("session", sessionId),
            "]}"
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    // ------------------------------------------------------------------ internals

    function _createSession(uint256 parentSessionId) internal returns (uint256 sessionId) {
        sessionId = ++_sessionCount;
        // See `hit`: block numbers fit in uint64 for any realistic chain lifetime.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 startBlock = uint64(block.number);
        SessionData storage s = _sessions[sessionId];
        s.startBlock = startBlock;
        s.host = msg.sender;
        s.parentSessionId = parentSessionId;
        emit SessionStarted(sessionId, startBlock, msg.sender, parentSessionId);
    }

    function _attribute(string memory traitType, uint256 value) internal pure returns (string memory) {
        return string.concat('{"trait_type":"', traitType, '","value":', value.toString(), "}");
    }

    /// @dev 16 columns (steps) × 8 rows (tracks). A cell is lit when any of the track's 32
    ///      note bits is set on that step. Cells are 20px on a 336×176 canvas.
    function _renderSvg(uint256[16] memory words) internal pure returns (string memory svg) {
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 336 176" shape-rendering="crispEdges">'
            '<rect width="336" height="176" fill="#0b0b12"/>';
        for (uint256 step = 0; step < STEPS; step++) {
            uint256 word = words[step];
            if (word == 0) continue;
            for (uint256 track = 0; track < TRACKS; track++) {
                if ((word >> (track * NOTES_PER_TRACK)) & 0xFFFFFFFF == 0) continue;
                svg = string.concat(
                    svg,
                    '<rect x="',
                    (8 + step * 20).toString(),
                    '" y="',
                    (8 + track * 20).toString(),
                    '" width="18" height="18" rx="2" fill="',
                    _trackColor(track),
                    '"/>'
                );
            }
        }
        svg = string.concat(svg, "</svg>");
    }

    /// @dev Track colours: kick, snare, hat, clap, bass, lead, pad, fx.
    function _trackColor(uint256 track) internal pure returns (string memory) {
        if (track == 0) return "#ff3b5c";
        if (track == 1) return "#ff9f1c";
        if (track == 2) return "#ffe66d";
        if (track == 3) return "#2ec4b6";
        if (track == 4) return "#3a86ff";
        if (track == 5) return "#8338ec";
        if (track == 6) return "#ff70e0";
        return "#c7f464";
    }
}
