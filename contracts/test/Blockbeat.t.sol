// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Blockbeat} from "../src/Blockbeat.sol";

/// @dev Player contract whose receive() reverts, to exercise the claim transfer-failure path.
contract RejectingPlayer {
    Blockbeat internal immutable bb;

    constructor(Blockbeat _bb) {
        bb = _bb;
    }

    function hit(uint256 sessionId) external {
        bb.hit(sessionId, 0, 0);
    }

    function claim(uint256 sessionId) external {
        bb.claim(sessionId);
    }

    receive() external payable {
        revert("no thanks");
    }
}

/// @dev Player contract that tries to re-enter claim from receive().
contract ReentrantPlayer {
    Blockbeat internal immutable bb;
    uint256 internal sessionId;
    uint256 public entries;

    constructor(Blockbeat _bb) {
        bb = _bb;
    }

    function hit(uint256 _sessionId) external {
        sessionId = _sessionId;
        bb.hit(_sessionId, 1, 1);
    }

    function claim() external {
        bb.claim(sessionId);
    }

    receive() external payable {
        entries++;
        if (entries < 3) {
            // Re-entry must find nothing to claim and revert, which bubbles up.
            bb.claim(sessionId);
        }
    }
}

contract BlockbeatTest is Test {
    Blockbeat internal bb;

    address internal host = makeAddr("host");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal tipper = makeAddr("tipper");
    address internal dj = makeAddr("dj");

    uint256 internal constant START_BLOCK = 1_000;

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

    function setUp() public {
        bb = new Blockbeat(dj);
        vm.roll(START_BLOCK);
        vm.deal(tipper, 1_000 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _start() internal returns (uint256 sessionId) {
        vm.prank(host);
        sessionId = bb.startSession();
    }

    function _hit(uint256 sessionId, address player, uint8 track, uint8 note) internal {
        vm.prank(player);
        bb.hit(sessionId, track, note);
    }

    function _bit(uint8 track, uint8 note) internal pure returns (uint256) {
        return uint256(1) << (uint256(track) * 32 + uint256(note));
    }

    function _finalize(uint256 sessionId) internal returns (uint256 tokenId) {
        vm.prank(host);
        tokenId = bb.finalize(sessionId);
    }

    // ------------------------------------------------------------------ sessions

    function test_startSession_assignsIncrementingIdsFromOne() public {
        uint256 a = _start();
        uint256 b = _start();
        assertEq(a, 1);
        assertEq(b, 2);
    }

    function test_startSession_recordsHostStartBlockAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit SessionStarted(1, uint64(START_BLOCK), host, 0);
        uint256 id = _start();

        Blockbeat.Session memory s = bb.getSession(id);
        assertEq(s.startBlock, uint64(START_BLOCK));
        assertEq(s.host, host);
        assertFalse(s.finalized);
        assertEq(s.hitCount, 0);
        assertEq(s.tokenId, 0);
        assertEq(s.parentSessionId, 0);
        assertEq(s.tipPool, 0);
    }

    function test_getSession_unknownReverts() public {
        vm.expectRevert(Blockbeat.SessionNotFound.selector);
        bb.getSession(42);
    }

    function test_pattern_freshSessionIsAllZero() public {
        uint256 id = _start();
        uint256[16] memory p = bb.pattern(id);
        for (uint256 i = 0; i < 16; i++) {
            assertEq(p[i], 0);
        }
    }

    // ------------------------------------------------------------------ step derivation

    function test_stepOf_derivesFromBlockDeltaMod16AcrossWrap() public {
        uint256 id = _start();
        for (uint64 k = 0; k < 40; k++) {
            assertEq(bb.stepOf(id, uint64(START_BLOCK) + k), uint8(k % 16), "step mismatch");
        }
    }

    function test_stepOf_blockBeforeStartReverts() public {
        uint256 id = _start();
        vm.expectRevert(Blockbeat.BlockBeforeStart.selector);
        bb.stepOf(id, uint64(START_BLOCK) - 1);
    }

    function test_hit_landsOnStepOfCurrentBlockAcrossWrap() public {
        uint256 id = _start();
        // Blocks 0..15 then 16 wraps to step 0, 17 to step 1.
        for (uint256 k = 0; k < 18; k++) {
            vm.roll(START_BLOCK + k);
            _hit(id, alice, 0, uint8(k)); // distinct note per hit so nothing toggles off
        }
        uint256[16] memory p = bb.pattern(id);
        // step 0 got note 0 (block 1000) and note 16 (block 1016)
        assertEq(p[0], _bit(0, 0) | _bit(0, 16));
        // step 1 got note 1 and note 17
        assertEq(p[1], _bit(0, 1) | _bit(0, 17));
        for (uint8 s = 2; s < 16; s++) {
            assertEq(p[s], _bit(0, s));
        }
    }

    // ------------------------------------------------------------------ hit semantics

    function test_hit_setsBitTrackTimes32PlusNoteAndEmitsOn() public {
        uint256 id = _start();
        vm.roll(START_BLOCK + 5);
        vm.expectEmit(true, true, true, true);
        emit Hit(id, alice, uint64(START_BLOCK + 5), 5, 3, 7, true);
        _hit(id, alice, 3, 7);
        assertEq(bb.pattern(id)[5], _bit(3, 7));
    }

    function test_hit_secondTapTogglesOffAndEmitsOff() public {
        uint256 id = _start();
        vm.roll(START_BLOCK + 2);
        _hit(id, alice, 7, 31);
        assertEq(bb.pattern(id)[2], _bit(7, 31));

        vm.expectEmit(true, true, true, true);
        emit Hit(id, bob, uint64(START_BLOCK + 2), 2, 7, 31, false);
        _hit(id, bob, 7, 31);
        assertEq(bb.pattern(id)[2], 0);
    }

    function test_hit_toggleOffStillCountsAsAHit() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _hit(id, alice, 0, 0);
        assertEq(bb.getSession(id).hitCount, 2);
        assertEq(bb.hitsOf(id, alice), 2);
    }

    function test_hit_trackOutOfRangeReverts() public {
        uint256 id = _start();
        vm.expectRevert(Blockbeat.TrackOutOfRange.selector);
        _hit(id, alice, 8, 0);
    }

    function test_hit_noteOutOfRangeReverts() public {
        uint256 id = _start();
        vm.expectRevert(Blockbeat.NoteOutOfRange.selector);
        _hit(id, alice, 0, 32);
    }

    function test_hit_boundaryTrack7Note31Allowed() public {
        uint256 id = _start();
        _hit(id, alice, 7, 31);
        assertEq(bb.pattern(id)[0], uint256(1) << 255);
    }

    function test_hit_unknownSessionReverts() public {
        vm.expectRevert(Blockbeat.SessionNotFound.selector);
        _hit(99, alice, 0, 0);
    }

    function test_hit_afterFinalizeReverts() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _finalize(id);
        vm.expectRevert(Blockbeat.SessionFinalized.selector);
        _hit(id, alice, 0, 1);
    }

    // ------------------------------------------------------------------ attribution

    function test_attribution_hitsOfAndHitCount() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _hit(id, alice, 1, 0);
        _hit(id, bob, 2, 0);
        assertEq(bb.hitsOf(id, alice), 2);
        assertEq(bb.hitsOf(id, bob), 1);
        assertEq(bb.hitsOf(id, carol), 0);
        assertEq(bb.getSession(id).hitCount, 3);
    }

    function test_attribution_contributorsAppendedOncePerPlayer() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _hit(id, alice, 0, 1);
        _hit(id, bob, 0, 2);
        _hit(id, alice, 0, 3);
        address[] memory c = bb.contributorsOf(id);
        assertEq(c.length, 2);
        assertEq(c[0], alice);
        assertEq(c[1], bob);
    }

    function test_attribution_isPerSession() public {
        uint256 a = _start();
        uint256 b = _start();
        _hit(a, alice, 0, 0);
        assertEq(bb.hitsOf(b, alice), 0);
        assertEq(bb.contributorsOf(b).length, 0);
        assertEq(bb.pattern(b)[0], 0);
    }

    // ------------------------------------------------------------------ tips

    function test_tip_accumulatesAndEmits() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0); // tips need at least one claimant
        vm.expectEmit(true, true, true, true);
        emit Tipped(id, tipper, 1 ether);
        vm.prank(tipper);
        bb.tip{value: 1 ether}(id);
        vm.prank(tipper);
        bb.tip{value: 0.5 ether}(id);
        assertEq(bb.getSession(id).tipPool, 1.2 ether, "80 % of each tip goes to the players' pool");
        assertEq(bb.hostTipsOf(id), 0.3 ether, "20 % to the host");
        assertEq(address(bb).balance, 1.5 ether);
    }

    function test_tip_allowedAfterFinalize() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _finalize(id);
        vm.prank(tipper);
        bb.tip{value: 1 ether}(id);
        assertEq(bb.getSession(id).tipPool, 0.8 ether);
    }

    function test_tip_zeroValueReverts() public {
        uint256 id = _start();
        vm.expectRevert(Blockbeat.ZeroTip.selector);
        vm.prank(tipper);
        bb.tip{value: 0}(id);
    }

    function test_tip_unknownSessionReverts() public {
        vm.expectRevert(Blockbeat.SessionNotFound.selector);
        vm.prank(tipper);
        bb.tip{value: 1 ether}(7);
    }

    // ------------------------------------------------------------------ claims

    function _tipAndFinalize(uint256 id, uint256 amount) internal {
        vm.prank(tipper);
        bb.tip{value: amount}(id);
        _finalize(id);
    }

    function test_claim_paysProRataByHits() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _hit(id, alice, 0, 1);
        _hit(id, alice, 0, 2);
        _hit(id, bob, 1, 0);
        _tipAndFinalize(id, 5 ether); // host 1, players' pool 4

        assertEq(bb.claimableOf(id, alice), 3 ether);
        assertEq(bb.claimableOf(id, bob), 1 ether);

        vm.expectEmit(true, true, true, true);
        emit Claimed(id, alice, 3 ether);
        vm.prank(alice);
        bb.claim(id);
        assertEq(alice.balance, 3 ether);

        vm.prank(bob);
        bb.claim(id);
        assertEq(bob.balance, 1 ether);
        assertEq(address(bb).balance, 1 ether, "only the host share is left");
    }

    function test_claim_cannotClaimTwice() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _tipAndFinalize(id, 1 ether);

        vm.prank(alice);
        bb.claim(id);
        assertEq(bb.claimableOf(id, alice), 0);

        vm.expectRevert(Blockbeat.NothingToClaim.selector);
        vm.prank(alice);
        bb.claim(id);
        assertEq(alice.balance, 0.8 ether);
    }

    function test_claim_afterMoreTipsPaysOnlyTheDelta() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _hit(id, bob, 0, 1);
        _tipAndFinalize(id, 2.5 ether); // players' pool 2

        vm.prank(alice);
        bb.claim(id);
        assertEq(alice.balance, 1 ether);

        vm.prank(tipper);
        bb.tip{value: 2.5 ether}(id);
        assertEq(bb.claimableOf(id, alice), 1 ether);
        assertEq(bb.claimableOf(id, bob), 2 ether);

        vm.prank(alice);
        bb.claim(id);
        assertEq(alice.balance, 2 ether);
        vm.prank(bob);
        bb.claim(id);
        assertEq(bob.balance, 2 ether);
    }

    function test_claim_withZeroHitsReverts() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _tipAndFinalize(id, 1 ether);
        vm.expectRevert(Blockbeat.NoHits.selector);
        vm.prank(carol);
        bb.claim(id);
    }

    function test_claim_beforeFinalizeReverts() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        vm.prank(tipper);
        bb.tip{value: 1 ether}(id);
        assertEq(bb.claimableOf(id, alice), 0, "nothing claimable while live");
        vm.expectRevert(Blockbeat.SessionNotFinalized.selector);
        vm.prank(alice);
        bb.claim(id);
    }

    function test_claim_withNoTipsReverts() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0);
        _finalize(id);
        vm.expectRevert(Blockbeat.NothingToClaim.selector);
        vm.prank(alice);
        bb.claim(id);
    }

    function test_claim_transferFailureRevertsAndKeepsState() public {
        uint256 id = _start();
        RejectingPlayer rp = new RejectingPlayer(bb);
        rp.hit(id);
        _tipAndFinalize(id, 1 ether);
        vm.expectRevert(Blockbeat.TransferFailed.selector);
        rp.claim(id);
        assertEq(bb.claimableOf(id, address(rp)), 0.8 ether);
    }

    function test_claim_reentrancyCannotDoubleClaim() public {
        uint256 id = _start();
        ReentrantPlayer rp = new ReentrantPlayer(bb);
        rp.hit(id);
        _hit(id, alice, 0, 0);
        _tipAndFinalize(id, 2 ether);
        // CEI: the re-entrant call sees claimed == share and reverts; the failed inner
        // call makes the outer transfer fail, which reverts the whole claim.
        vm.expectRevert(Blockbeat.TransferFailed.selector);
        rp.claim();
        // Nothing paid, state intact.
        assertEq(address(rp).balance, 0);
        assertEq(bb.claimableOf(id, address(rp)), 0.8 ether);
    }

    /// @dev Invariant: no matter how hits and tips are distributed, the sum of all
    /// successful player claims never exceeds tipPool (the 80 % players' pool).
    function testFuzz_totalClaimsNeverExceedTipPool(uint8[5] memory hitsPer, uint96 tip1, uint96 tip2) public {
        uint256 id = _start();
        address[5] memory players = [makeAddr("p0"), makeAddr("p1"), makeAddr("p2"), makeAddr("p3"), makeAddr("p4")];

        uint256 totalHits;
        for (uint256 i = 0; i < 5; i++) {
            uint256 n = uint256(hitsPer[i]) % 20;
            for (uint256 j = 0; j < n; j++) {
                _hit(id, players[i], uint8(i), uint8(j));
            }
            totalHits += n;
        }
        vm.assume(totalHits > 0);

        vm.deal(tipper, uint256(tip1) + uint256(tip2));
        if (tip1 > 0) {
            vm.prank(tipper);
            bb.tip{value: tip1}(id);
        }
        _finalize(id);

        uint256 paid;
        for (uint256 i = 0; i < 5; i++) {
            paid += _tryClaim(id, players[i]);
        }
        assertLe(paid, uint256(tip1));

        if (tip2 > 0) {
            vm.prank(tipper);
            bb.tip{value: tip2}(id);
        }
        for (uint256 i = 0; i < 5; i++) {
            paid += _tryClaim(id, players[i]);
        }
        uint256 pool = bb.getSession(id).tipPool;
        assertLe(paid, pool);
        assertEq(address(bb).balance, pool - paid + bb.hostTipsOf(id), "unclaimed pool + host share");
        assertEq(pool + bb.hostTipsOf(id), uint256(tip1) + uint256(tip2));
    }

    function _tryClaim(uint256 id, address player) internal returns (uint256 got) {
        uint256 before = player.balance;
        vm.prank(player);
        try bb.claim(id) {
            got = player.balance - before;
        } catch {
            got = 0;
        }
    }

    // ------------------------------------------------------------------ remix

    function test_remix_copiesWordsAndSetsParent() public {
        uint256 parent = _start();
        vm.roll(START_BLOCK + 3);
        _hit(parent, alice, 2, 5);
        vm.roll(START_BLOCK + 9);
        _hit(parent, bob, 4, 1);
        _finalize(parent);

        vm.roll(START_BLOCK + 100);
        vm.expectEmit(true, true, true, true);
        emit SessionStarted(2, uint64(START_BLOCK + 100), carol, parent);
        vm.prank(carol);
        uint256 child = bb.remix(parent);

        uint256[16] memory pp = bb.pattern(parent);
        uint256[16] memory cp = bb.pattern(child);
        for (uint256 i = 0; i < 16; i++) {
            assertEq(cp[i], pp[i]);
        }
        Blockbeat.Session memory s = bb.getSession(child);
        assertEq(s.parentSessionId, parent);
        assertEq(s.host, carol);
        assertEq(s.startBlock, uint64(START_BLOCK + 100));
        assertFalse(s.finalized);
        assertEq(s.hitCount, 0);
        assertEq(s.tipPool, 0);
        assertEq(bb.contributorsOf(child).length, 0);
    }

    function test_remix_childIsIndependentOfParent() public {
        uint256 parent = _start();
        _hit(parent, alice, 0, 0);
        _finalize(parent);
        vm.prank(carol);
        uint256 child = bb.remix(parent);
        _hit(child, bob, 0, 0); // toggles the copied bit off in the child only
        assertEq(bb.pattern(child)[0], 0);
        assertEq(bb.pattern(parent)[0], _bit(0, 0));
    }

    function test_remix_parentNotFinalizedReverts() public {
        uint256 parent = _start();
        vm.expectRevert(Blockbeat.SessionNotFinalized.selector);
        vm.prank(carol);
        bb.remix(parent);
    }

    function test_remix_unknownParentReverts() public {
        vm.expectRevert(Blockbeat.SessionNotFound.selector);
        vm.prank(carol);
        bb.remix(123);
    }

    // ------------------------------------------------------------------ finalize

    function test_finalize_hostOnly() public {
        uint256 id = _start();
        vm.expectRevert(Blockbeat.NotHost.selector);
        vm.prank(alice);
        bb.finalize(id);
    }

    function test_finalize_onlyOnce() public {
        uint256 id = _start();
        _finalize(id);
        vm.expectRevert(Blockbeat.SessionFinalized.selector);
        _finalize(id);
    }

    function test_finalize_unknownSessionReverts() public {
        vm.expectRevert(Blockbeat.SessionNotFound.selector);
        vm.prank(host);
        bb.finalize(5);
    }

    function test_finalize_mintsToHostEmitsAndStoresPattern() public {
        uint256 id = _start();
        vm.roll(START_BLOCK + 4);
        _hit(id, alice, 1, 2);
        _hit(id, bob, 6, 30);

        vm.expectEmit(true, true, true, true);
        emit Finalized(id, 1, 2);
        uint256 tokenId = _finalize(id);

        assertEq(tokenId, 1);
        assertEq(bb.ownerOf(tokenId), host);
        assertEq(bb.balanceOf(host), 1);
        Blockbeat.Session memory s = bb.getSession(id);
        assertTrue(s.finalized);
        assertEq(s.tokenId, tokenId);

        uint256[16] memory tp = bb.tokenPattern(tokenId);
        assertEq(tp[4], _bit(1, 2) | _bit(6, 30));
        for (uint256 i = 0; i < 16; i++) {
            if (i != 4) assertEq(tp[i], 0);
        }
        assertEq(bb.tokenSession(tokenId), id);
    }

    function test_finalize_tokenIdsIncrementAcrossSessions() public {
        uint256 a = _start();
        uint256 b = _start();
        assertEq(_finalize(b), 1);
        assertEq(_finalize(a), 2);
    }

    // ------------------------------------------------------------------ tokenURI

    function test_tokenURI_isBase64JsonWithSvgAndAttributes() public {
        uint256 parent = _start();
        _hit(parent, alice, 0, 0);
        _finalize(parent);
        vm.prank(host);
        uint256 id = bb.remix(parent);
        vm.roll(START_BLOCK + 7);
        _hit(id, alice, 3, 3);
        _hit(id, bob, 5, 9);
        _hit(id, bob, 5, 9); // toggles off, still a hit
        _hit(id, carol, 7, 31);
        uint256 tokenId = _finalize(id);

        string memory uri = bb.tokenURI(tokenId);
        string memory prefix = "data:application/json;base64,";
        assertEq(_slice(uri, 0, bytes(prefix).length), prefix);

        string memory json = string(Base64.decode(_slice(uri, bytes(prefix).length, bytes(uri).length)));

        assertEq(vm.parseJsonString(json, ".name"), "Blockbeat Track #2");
        assertTrue(bytes(vm.parseJsonString(json, ".description")).length > 0);

        string memory image = vm.parseJsonString(json, ".image");
        string memory imgPrefix = "data:image/svg+xml;base64,";
        assertEq(_slice(image, 0, bytes(imgPrefix).length), imgPrefix);
        string memory svg = string(Base64.decode(_slice(image, bytes(imgPrefix).length, bytes(image).length)));
        assertTrue(_contains(svg, "<svg"), "svg open tag");
        assertTrue(_contains(svg, "</svg>"), "svg close tag");
        assertTrue(_contains(svg, "<rect"), "svg has cells");

        assertEq(vm.parseJsonString(json, ".attributes[0].trait_type"), "hits");
        assertEq(vm.parseJsonUint(json, ".attributes[0].value"), 4);
        assertEq(vm.parseJsonString(json, ".attributes[1].trait_type"), "contributors");
        assertEq(vm.parseJsonUint(json, ".attributes[1].value"), 3);
        assertEq(vm.parseJsonString(json, ".attributes[2].trait_type"), "parent");
        assertEq(vm.parseJsonUint(json, ".attributes[2].value"), parent);
        assertEq(vm.parseJsonString(json, ".attributes[3].trait_type"), "session");
        assertEq(vm.parseJsonUint(json, ".attributes[3].value"), id);
    }

    function test_tokenURI_svgHasOneRectPerLitCell() public {
        uint256 id = _start();
        vm.roll(START_BLOCK + 1);
        _hit(id, alice, 0, 0); // step 1, track 0
        _hit(id, alice, 0, 1); // same cell (track 0), different note: still one cell
        vm.roll(START_BLOCK + 15);
        _hit(id, bob, 7, 0); // step 15, track 7
        uint256 tokenId = _finalize(id);

        string memory svg = _decodeSvg(bb.tokenURI(tokenId));
        // background rect + 2 lit cells
        assertEq(_count(svg, "<rect"), 3);
    }

    function test_tokenURI_unknownTokenReverts() public {
        vm.expectRevert();
        bb.tokenURI(1);
    }

    function test_erc721_metadata() public view {
        assertEq(bb.name(), "Blockbeat Track");
        assertEq(bb.symbol(), "BEAT");
    }

    // ------------------------------------------------------------------ gas

    function test_gas_hitUnder80kAfterFirstHit() public {
        uint256 id = _start();
        _hit(id, alice, 0, 0); // first hit: pays contributor append + cold slots
        vm.roll(START_BLOCK + 1);
        vm.prank(alice);
        uint256 g = gasleft();
        bb.hit(id, 1, 1);
        g -= gasleft();
        emit log_named_uint("hit gas (warm player)", g);
        assertLt(g, 80_000);
    }

    /// @dev A player's first hit pays five zero-to-nonzero SSTOREs (step word, player hits,
    /// the session's hitCount, which has its own slot since slot 0 holds startBlock + host +
    /// finalized, contributors length and element). Measured ~140k execution gas; this
    /// ceiling is what the web app's fixed gas limit for `hit` must cover (plus the 21k
    /// intrinsic cost). (Review L7: comment only; the measurement already includes it.)
    function test_gas_firstHitUnder160k() public {
        uint256 id = _start();
        vm.prank(alice);
        uint256 g = gasleft();
        bb.hit(id, 0, 0);
        g -= gasleft();
        emit log_named_uint("hit gas (first hit)", g);
        assertLt(g, 160_000);
    }

    // ------------------------------------------------------------------ security-review follow-ups

    function test_tip_toSessionWithNoHitsRevertsBeforeFinalize() public {
        uint256 id = _start();
        vm.expectRevert(Blockbeat.NoHits.selector);
        vm.prank(tipper);
        bb.tip{value: 1 ether}(id);
    }

    function test_tip_toFinalizedSessionWithNoHitsReverts() public {
        uint256 id = _start();
        _finalize(id); // empty session can still be finalized
        vm.expectRevert(Blockbeat.NoHits.selector);
        vm.prank(tipper);
        bb.tip{value: 1 ether}(id);
        assertEq(address(bb).balance, 0, "no wei can get stuck without a claimant");
    }

    function test_contributorCountAndSlice() public {
        uint256 id = _start();
        assertEq(bb.contributorCount(id), 0);
        assertEq(bb.contributorsSlice(id, 0, 10).length, 0);

        _hit(id, alice, 0, 0);
        _hit(id, bob, 0, 1);
        _hit(id, carol, 0, 2);
        _hit(id, alice, 0, 3);
        assertEq(bb.contributorCount(id), 3);

        address[] memory first2 = bb.contributorsSlice(id, 0, 2);
        assertEq(first2.length, 2);
        assertEq(first2[0], alice);
        assertEq(first2[1], bob);

        address[] memory tail = bb.contributorsSlice(id, 2, 10); // limit clamped to the end
        assertEq(tail.length, 1);
        assertEq(tail[0], carol);

        assertEq(bb.contributorsSlice(id, 3, 10).length, 0); // offset at the end
        assertEq(bb.contributorsSlice(id, 99, 10).length, 0); // offset past the end
    }

    // ------------------------------------------------------------------ string utils

    function _slice(string memory s, uint256 start, uint256 end) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = b[i];
        }
        return string(out);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        return _count(haystack, needle) > 0;
    }

    function _count(string memory haystack, string memory needle) internal pure returns (uint256 n) {
        bytes memory h = bytes(haystack);
        bytes memory nd = bytes(needle);
        if (nd.length == 0 || h.length < nd.length) return 0;
        for (uint256 i = 0; i + nd.length <= h.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < nd.length; j++) {
                if (h[i + j] != nd[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) n++;
        }
    }

    function _decodeSvg(string memory uri) internal pure returns (string memory) {
        string memory prefix = "data:application/json;base64,";
        string memory json = string(Base64.decode(_slice(uri, bytes(prefix).length, bytes(uri).length)));
        // Cheap extraction: find "data:image/svg+xml;base64," and read until the closing quote.
        bytes memory j = bytes(json);
        bytes memory marker = bytes("data:image/svg+xml;base64,");
        uint256 start = type(uint256).max;
        for (uint256 i = 0; i + marker.length <= j.length; i++) {
            bool ok = true;
            for (uint256 k = 0; k < marker.length; k++) {
                if (j[i + k] != marker[k]) {
                    ok = false;
                    break;
                }
            }
            if (ok) {
                start = i + marker.length;
                break;
            }
        }
        require(start != type(uint256).max, "no image");
        uint256 end = start;
        while (j[end] != '"') end++;
        return string(Base64.decode(_slice(json, start, end)));
    }
}
