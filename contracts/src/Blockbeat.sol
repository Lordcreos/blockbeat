// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title Blockbeat — a 16-step sequencer clocked by Monad blocks.
/// @notice Every block is one step. A `hit` toggles one note bit in the step word of the
///         block it lands in. Sessions are finalized into an ERC-721 whose metadata and
///         16×8 grid image live fully onchain. Tips are split pro rata by hits.
/// @dev No owner, no fees, no pausing, no upgradeability. See docs/SDD.md §4.2.
contract Blockbeat is ERC721 {
    using Strings for uint256;

    // ------------------------------------------------------------------ constants

    uint256 public constant STEPS = 16;
    uint256 public constant TRACKS = 8;
    uint256 public constant NOTES_PER_TRACK = 32;

    // ------------------------------------------------------------------ types

    struct Session {
        uint64 startBlock;
        address host;
        bool finalized;
        uint64 hitCount; // total hits in the session (attribution denominator)
        uint256 tokenId; // 0 until finalized
        uint256 parentSessionId; // 0 for an original, else the remixed session
        uint256 tipPool; // wei tipped to this session, claimable pro rata by hits
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

    // ------------------------------------------------------------------ storage

    /// @dev Sessions and tokens are 1-based so that 0 means "none" for parents and tokens.
    uint256 private _sessionCount;
    uint256 private _tokenCount;

    mapping(uint256 sessionId => Session) private _sessions;
    mapping(uint256 sessionId => uint256[16]) private _steps;
    mapping(uint256 sessionId => mapping(address player => uint64)) private _hits;
    mapping(uint256 sessionId => mapping(address player => uint256)) private _claimed;
    mapping(uint256 sessionId => address[]) private _contributors;

    mapping(uint256 tokenId => uint256[16]) private _tokenPatterns;
    mapping(uint256 tokenId => uint256) private _tokenSessions;

    constructor() ERC721("Blockbeat Track", "BEAT") {}

    // ------------------------------------------------------------------ writes

    /// @notice Start a new, empty session hosted by the caller. Step 0 is the current block.
    function startSession() external returns (uint256 sessionId) {
        sessionId = _createSession(0);
    }

    /// @notice Fork a finalized session: the 16 step words are copied and the parent recorded.
    function remix(uint256 parentSessionId) external returns (uint256 sessionId) {
        Session storage parent = _sessions[parentSessionId];
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
        Session storage s = _sessions[sessionId];
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
        uint64 playerHits = _hits[sessionId][msg.sender];
        _hits[sessionId][msg.sender] = playerHits + 1;
        if (playerHits == 0) _contributors[sessionId].push(msg.sender);

        // Block numbers fit in uint64 for any realistic chain lifetime (2^64 blocks at
        // 300 ms is ~175 billion years).
        // forge-lint: disable-next-line(unsafe-typecast)
        emit Hit(sessionId, msg.sender, uint64(block.number), step, track, note, word & mask != 0);
    }

    /// @notice Tip a session. Allowed before and after finalize. Split pro rata by hits.
    /// @dev Rejected while the session has no hits: `hitCount` never decreases, so every
    ///      accepted tip always has at least one claimant and no wei can be stranded.
    function tip(uint256 sessionId) external payable {
        Session storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        if (msg.value == 0) revert ZeroTip();
        if (s.hitCount == 0) revert NoHits();

        s.tipPool += msg.value;
        emit Tipped(sessionId, msg.sender, msg.value);
    }

    /// @notice Finalize a session (host only, once): freezes the pattern and mints the track
    ///         NFT to the host. The token stores its own copy of the 16 pattern words.
    function finalize(uint256 sessionId) external returns (uint256 tokenId) {
        Session storage s = _sessions[sessionId];
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

    /// @notice Pull the caller's share of the tip pool: `tipPool * hits / hitCount` minus what
    ///         was already claimed. Only after finalize, so the denominator is frozen and the
    ///         sum of all shares can never exceed `tipPool`.
    function claim(uint256 sessionId) external {
        Session storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        if (!s.finalized) revert SessionNotFinalized();
        uint64 playerHits = _hits[sessionId][msg.sender];
        if (playerHits == 0) revert NoHits();

        uint256 share = (s.tipPool * playerHits) / s.hitCount;
        uint256 already = _claimed[sessionId][msg.sender];
        if (share <= already) revert NothingToClaim();
        uint256 amount = share - already;

        // Effects before interaction.
        _claimed[sessionId][msg.sender] = share;
        emit Claimed(sessionId, msg.sender, amount);

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
        Session storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        if (blockNumber < s.startBlock) revert BlockBeforeStart();
        // Result is < 16, so the cast cannot truncate.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8((uint256(blockNumber) - s.startBlock) % STEPS);
    }

    function getSession(uint256 sessionId) external view returns (Session memory) {
        Session storage s = _sessions[sessionId];
        if (s.host == address(0)) revert SessionNotFound();
        return s;
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

    /// @notice Wei the player could claim right now (0 while the session is live).
    function claimableOf(uint256 sessionId, address player) external view returns (uint256) {
        Session storage s = _sessions[sessionId];
        if (!s.finalized) return 0;
        uint64 playerHits = _hits[sessionId][player];
        if (playerHits == 0) return 0;
        uint256 share = (s.tipPool * playerHits) / s.hitCount;
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
        Session storage s = _sessions[sessionId];

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
        Session storage s = _sessions[sessionId];
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
