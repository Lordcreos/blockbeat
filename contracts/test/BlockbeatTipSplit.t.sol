// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdError} from "forge-std/Test.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Blockbeat} from "../src/Blockbeat.sol";

/// @dev Host that also plays, and re-enters from the NFT mint callback during `finalize`:
///      claims its host share, re-tips part of it, then claims its player share.
contract MintReentrantHost is IERC721Receiver {
    Blockbeat internal immutable bb;
    uint256 internal sessionId;

    constructor(Blockbeat _bb) {
        bb = _bb;
    }

    function start() external returns (uint256) {
        sessionId = bb.startSession();
        return sessionId;
    }

    function hit() external {
        bb.hit(sessionId, 4, 4);
    }

    function finalize() external {
        bb.finalize(sessionId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        bb.claimHost(sessionId);
        bb.tip{value: 1 ether}(sessionId);
        bb.claim(sessionId);
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}

/// @dev Host contract whose receive() reverts, to exercise the host claim failure path and
///      to prove that `tip` never pushes value to the host.
contract RejectingHost {
    Blockbeat internal immutable bb;

    constructor(Blockbeat _bb) {
        bb = _bb;
    }

    function start() external returns (uint256) {
        return bb.startSession();
    }

    function claimHost(uint256 sessionId) external {
        bb.claimHost(sessionId);
    }

    receive() external payable {
        revert("no thanks");
    }
}

/// @dev Host contract that re-enters from receive(): either claimHost again or tip.
contract ReentrantHost {
    Blockbeat internal immutable bb;
    uint256 internal sessionId;
    bool internal reenterWithTip;
    uint256 public entries;

    constructor(Blockbeat _bb) {
        bb = _bb;
    }

    function start(bool withTip) external returns (uint256) {
        reenterWithTip = withTip;
        sessionId = bb.startSession();
        return sessionId;
    }

    function claimHost() external {
        bb.claimHost(sessionId);
    }

    receive() external payable {
        entries++;
        if (entries > 1) return;
        if (reenterWithTip) {
            // Re-tip the whole payout into the same session: legal, and fully accounted.
            bb.tip{value: msg.value}(sessionId);
        } else {
            // Re-entry must find nothing left and revert, which bubbles up.
            bb.claimHost(sessionId);
        }
    }
}

/// @dev Player contract that re-enters `tip` from receive() during its own claim.
contract TippingPlayer {
    Blockbeat internal immutable bb;
    uint256 internal sessionId;

    constructor(Blockbeat _bb) {
        bb = _bb;
    }

    function hit(uint256 _sessionId) external {
        sessionId = _sessionId;
        bb.hit(_sessionId, 2, 2);
    }

    function claim() external {
        bb.claim(sessionId);
    }

    receive() external payable {
        bb.tip{value: msg.value}(sessionId);
    }
}

/// @notice Host / players tip split (W21a): 20 % of every tip to the session host, 80 % to
///         the players' pool, split among HUMAN players by hits. The resident DJ agent's
///         hits count for the pattern and the NFT, never for the money.
contract BlockbeatTipSplitTest is Test {
    Blockbeat internal bb;

    address internal dj = makeAddr("dj");
    address internal host = makeAddr("host");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal tipper = makeAddr("tipper");

    event Tipped(uint256 indexed sessionId, address indexed from, uint256 amount);
    event TipSplit(uint256 indexed sessionId, uint256 hostAmount, uint256 poolAmount);
    event HostClaimed(uint256 indexed sessionId, address indexed host, uint256 amount);
    event Claimed(uint256 indexed sessionId, address indexed player, uint256 amount);

    function setUp() public {
        bb = new Blockbeat(dj);
        vm.roll(1_000);
        vm.deal(tipper, type(uint128).max);
    }

    // ------------------------------------------------------------------ helpers

    function _start() internal returns (uint256 id) {
        vm.prank(host);
        id = bb.startSession();
    }

    function _hits(uint256 id, address player, uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            vm.prank(player);
            // forge-lint: disable-next-line(unsafe-typecast)
            bb.hit(id, 3, uint8(i % 32));
        }
    }

    function _tip(uint256 id, uint256 amount) internal {
        vm.prank(tipper);
        bb.tip{value: amount}(id);
    }

    function _finalize(uint256 id) internal {
        vm.prank(host);
        bb.finalize(id);
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_storesAgent() public view {
        assertEq(bb.agent(), dj);
    }

    function test_constructor_zeroAgentReverts() public {
        vm.expectRevert(Blockbeat.ZeroAgent.selector);
        new Blockbeat(address(0));
    }

    function test_hostTipBpsIs20Percent() public view {
        assertEq(bb.HOST_TIP_BPS(), 2000);
        assertEq(bb.BPS_DENOMINATOR(), 10_000);
    }

    // ------------------------------------------------------------------ human hit count

    function test_humanHitCount_excludesAgentButAgentStillContributes() public {
        uint256 id = _start();
        _hits(id, dj, 4);
        _hits(id, alice, 3);

        assertEq(bb.getSession(id).hitCount, 7, "agent hits count for the pattern");
        assertEq(bb.humanHitCountOf(id), 3, "agent hits do not count for tips");
        assertEq(bb.hitsOf(id, dj), 4);
        assertEq(bb.contributorCount(id), 2, "agent co-owns the track");
        assertEq(bb.contributorsOf(id)[0], dj);
    }

    function test_humanHitCount_unknownSessionIsZero() public view {
        assertEq(bb.humanHitCountOf(42), 0);
    }

    // ------------------------------------------------------------------ tip split

    function test_tip_splits20ToHost80ToPoolAndEmits() public {
        uint256 id = _start();
        _hits(id, alice, 1);

        vm.expectEmit(true, true, true, true);
        emit Tipped(id, tipper, 1 ether);
        vm.expectEmit(true, true, true, true);
        emit TipSplit(id, 0.2 ether, 0.8 ether);
        _tip(id, 1 ether);

        assertEq(bb.getSession(id).tipPool, 0.8 ether);
        assertEq(bb.hostTipsOf(id), 0.2 ether);
        assertEq(bb.hostClaimableOf(id), 0.2 ether);
        assertEq(bb.totalTipsOf(id), 1 ether);
        assertEq(address(bb).balance, 1 ether);
        assertEq(host.balance, 0, "host is paid by pull, never pushed in tip");
    }

    function test_tip_oddWeiNeverLosesAWei() public {
        uint256 id = _start();
        _hits(id, alice, 1);
        _tip(id, 7); // 7 * 2000 / 10000 = 1 (floor), pool gets the rest
        assertEq(bb.hostTipsOf(id), 1);
        assertEq(bb.getSession(id).tipPool, 6);
        _tip(id, 1); // host floor is 0, the single wei goes to the pool
        assertEq(bb.hostTipsOf(id), 1);
        assertEq(bb.getSession(id).tipPool, 7);
        assertEq(bb.totalTipsOf(id), 8);
    }

    function test_tip_withOnlyAgentHitsGoesFullyToHost() public {
        uint256 id = _start();
        _hits(id, dj, 2);

        vm.expectEmit(true, true, true, true);
        emit TipSplit(id, 1 ether, 0);
        _tip(id, 1 ether);

        assertEq(bb.getSession(id).tipPool, 0);
        assertEq(bb.hostTipsOf(id), 1 ether);
    }

    function test_tip_beforeAnyNoteStillReverts() public {
        uint256 id = _start();
        vm.expectRevert(Blockbeat.NoHits.selector);
        _tip(id, 1 ether);
    }

    function test_tip_agentOnlyThenHumansJoin() public {
        uint256 id = _start();
        _hits(id, dj, 1);
        _tip(id, 1 ether); // 100 % host
        _hits(id, alice, 1);
        _tip(id, 1 ether); // 20 / 80
        assertEq(bb.hostTipsOf(id), 1.2 ether);
        assertEq(bb.getSession(id).tipPool, 0.8 ether);

        _finalize(id);
        assertEq(bb.claimableOf(id, alice), 0.8 ether);
        assertEq(bb.claimableOf(id, dj), 0);
    }

    function test_tip_worksWhenHostRejectsEther() public {
        RejectingHost rh = new RejectingHost(bb);
        uint256 id = rh.start();
        _hits(id, alice, 1);
        _tip(id, 1 ether); // no push to the host, so a hostile host cannot block tips
        assertEq(bb.hostTipsOf(id), 0.2 ether);
    }

    // ------------------------------------------------------------------ human claims

    function test_claim_splitsPoolAmongHumansOnlyByHits() public {
        uint256 id = _start();
        _hits(id, alice, 3);
        _hits(id, bob, 1);
        _hits(id, dj, 4); // would halve every human share if it counted
        _tip(id, 5 ether); // host 1, pool 4
        _finalize(id);

        assertEq(bb.claimableOf(id, alice), 3 ether);
        assertEq(bb.claimableOf(id, bob), 1 ether);
        assertEq(bb.claimableOf(id, dj), 0);

        vm.expectEmit(true, true, true, true);
        emit Claimed(id, alice, 3 ether);
        vm.prank(alice);
        bb.claim(id);
        vm.prank(bob);
        bb.claim(id);
        assertEq(alice.balance, 3 ether);
        assertEq(bob.balance, 1 ether);
        assertEq(address(bb).balance, 1 ether, "only the host share is left");
    }

    function test_claim_agentRevertsNothingToClaim() public {
        uint256 id = _start();
        _hits(id, dj, 2);
        _hits(id, alice, 1);
        _tip(id, 1 ether);
        _finalize(id);

        vm.expectRevert(Blockbeat.NothingToClaim.selector);
        vm.prank(dj);
        bb.claim(id);
        assertEq(dj.balance, 0);
    }

    function test_claim_humanWhenPoolEmptyBecauseOnlyAgentPlayedAtTipTime() public {
        uint256 id = _start();
        _hits(id, dj, 1);
        _tip(id, 1 ether); // all to host
        _hits(id, alice, 1);
        _finalize(id);
        assertEq(bb.claimableOf(id, alice), 0);
        vm.expectRevert(Blockbeat.NothingToClaim.selector);
        vm.prank(alice);
        bb.claim(id);
    }

    function test_claim_reentrantTipFromReceiveIsAccounted() public {
        uint256 id = _start();
        TippingPlayer tp = new TippingPlayer(bb);
        tp.hit(id);
        _hits(id, alice, 1);
        _tip(id, 10 ether); // host 2, pool 8 -> 4 each
        _finalize(id);

        tp.claim(); // receives 4, re-tips 4 inside receive: host +0.8, pool +3.2
        assertEq(bb.hostTipsOf(id), 2.8 ether);
        assertEq(bb.getSession(id).tipPool, 11.2 ether);
        // tp already took 4 of its 5.6 share; alice gets 5.6.
        assertEq(bb.claimableOf(id, address(tp)), 1.6 ether);
        assertEq(bb.claimableOf(id, alice), 5.6 ether);
        assertEq(address(bb).balance, 10 ether, "10 in, 4 out, 4 back in");
    }

    // ------------------------------------------------------------------ host claims

    function test_claimHost_paysHostShareBeforeFinalizeAndEmits() public {
        uint256 id = _start();
        _hits(id, alice, 1);
        _tip(id, 1 ether);

        vm.expectEmit(true, true, true, true);
        emit HostClaimed(id, host, 0.2 ether);
        vm.prank(host);
        bb.claimHost(id);

        assertEq(host.balance, 0.2 ether);
        assertEq(bb.hostClaimableOf(id), 0);
        assertEq(bb.hostTipsOf(id), 0.2 ether, "earned total stays for the UI");
    }

    function test_claimHost_onlyHost() public {
        uint256 id = _start();
        _hits(id, alice, 1);
        _tip(id, 1 ether);
        vm.expectRevert(Blockbeat.NotHost.selector);
        vm.prank(alice);
        bb.claimHost(id);
    }

    function test_claimHost_unknownSessionReverts() public {
        vm.expectRevert(Blockbeat.SessionNotFound.selector);
        vm.prank(host);
        bb.claimHost(9);
    }

    function test_claimHost_nothingToClaimAndNoDoubleClaim() public {
        uint256 id = _start();
        vm.expectRevert(Blockbeat.NothingToClaim.selector);
        vm.prank(host);
        bb.claimHost(id);

        _hits(id, alice, 1);
        _tip(id, 1 ether);
        vm.prank(host);
        bb.claimHost(id);
        vm.expectRevert(Blockbeat.NothingToClaim.selector);
        vm.prank(host);
        bb.claimHost(id);
        assertEq(host.balance, 0.2 ether);
    }

    function test_claimHost_paysOnlyTheDeltaAfterMoreTips() public {
        uint256 id = _start();
        _hits(id, alice, 1);
        _tip(id, 1 ether);
        vm.prank(host);
        bb.claimHost(id);
        _finalize(id);
        _tip(id, 2 ether);
        assertEq(bb.hostClaimableOf(id), 0.4 ether);
        vm.prank(host);
        bb.claimHost(id);
        assertEq(host.balance, 0.6 ether);
        assertEq(bb.hostTipsOf(id), 0.6 ether);
    }

    function test_claimHost_transferFailureRevertsAndKeepsState() public {
        RejectingHost rh = new RejectingHost(bb);
        uint256 id = rh.start();
        _hits(id, alice, 1);
        _tip(id, 1 ether);
        vm.expectRevert(Blockbeat.TransferFailed.selector);
        rh.claimHost(id);
        assertEq(bb.hostClaimableOf(id), 0.2 ether);
        assertEq(address(bb).balance, 1 ether);
    }

    function test_claimHost_reentrancyCannotDoubleClaim() public {
        ReentrantHost rh = new ReentrantHost(bb);
        uint256 id = rh.start(false);
        _hits(id, alice, 1);
        _tip(id, 1 ether);
        // CEI: the nested claimHost finds nothing and reverts, which fails the outer transfer.
        vm.expectRevert(Blockbeat.TransferFailed.selector);
        rh.claimHost();
        assertEq(address(rh).balance, 0);
        assertEq(bb.hostClaimableOf(id), 0.2 ether);
    }

    function test_claimHost_reentrantTipIsAccounted() public {
        ReentrantHost rh = new ReentrantHost(bb);
        uint256 id = rh.start(true);
        _hits(id, alice, 1);
        _tip(id, 1 ether); // host 0.2
        rh.claimHost(); // receives 0.2 and re-tips it: host +0.04, pool +0.16
        assertEq(bb.hostTipsOf(id), 0.24 ether);
        assertEq(bb.hostClaimableOf(id), 0.04 ether);
        assertEq(bb.getSession(id).tipPool, 0.96 ether);
        assertEq(address(bb).balance, 1 ether);
    }

    function test_hostWhoAlsoPlaysGetsBothShares() public {
        uint256 id = _start();
        _hits(id, host, 1);
        _hits(id, alice, 1);
        _tip(id, 10 ether); // host 2, pool 8 -> 4 each
        _finalize(id);
        vm.startPrank(host);
        bb.claimHost(id);
        bb.claim(id);
        vm.stopPrank();
        assertEq(host.balance, 6 ether);
    }

    function test_finalize_mintCallbackReentryKeepsAccountingConsistent() public {
        MintReentrantHost mh = new MintReentrantHost(bb);
        uint256 id = mh.start();
        mh.hit();
        _hits(id, alice, 1);
        _tip(id, 10 ether); // host 2, pool 8

        // Inside onERC721Received: claimHost (+2), tip 1 (host +0.2, pool +0.8), claim 8.8/2.
        mh.finalize();

        assertTrue(bb.getSession(id).finalized);
        assertEq(bb.hostTipsOf(id), 2.2 ether);
        assertEq(bb.hostClaimableOf(id), 0.2 ether);
        assertEq(bb.getSession(id).tipPool, 8.8 ether);
        assertEq(bb.claimableOf(id, address(mh)), 0);
        assertEq(bb.claimableOf(id, alice), 4.4 ether);
        assertEq(address(mh).balance, 5.4 ether, "2 host - 1 re-tip + 4.4 player");
        assertEq(address(bb).balance, 4.6 ether, "0.2 host + 4.4 alice still owed");
        assertEq(bb.ownerOf(bb.getSession(id).tokenId), address(mh));
    }

    // ------------------------------------------------------------------ bounds

    function test_tip_hostShareAboveUint128Reverts() public {
        uint256 id = _start();
        _hits(id, dj, 1); // agent-only: the whole tip is the host share
        uint256 big = uint256(type(uint128).max) + 1;
        vm.deal(tipper, big);
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 128, big));
        _tip(id, big);
        assertEq(bb.hostTipsOf(id), 0);
        assertEq(bb.totalTipsOf(id), 0);
    }

    function test_tip_hostTipsAccumulationOverflowReverts() public {
        uint256 id = _start();
        _hits(id, dj, 1);
        vm.deal(tipper, uint256(type(uint128).max) + 1);
        _tip(id, type(uint128).max);
        vm.expectRevert(stdError.arithmeticError);
        _tip(id, 1);
        assertEq(bb.hostTipsOf(id), type(uint128).max, "state unchanged by the reverted tip");
    }

    // ------------------------------------------------------------------ isolation

    function test_sessionsAreIsolated() public {
        uint256 a = _start();
        address host2 = makeAddr("host2");
        vm.prank(host2);
        uint256 b = bb.startSession();

        _hits(a, alice, 2);
        _hits(b, bob, 1);
        _hits(b, dj, 3);
        _tip(a, 1 ether); // host 0.2, pool 0.8
        _tip(b, 5 ether); // host 1, pool 4

        assertEq(bb.humanHitCountOf(a), 2);
        assertEq(bb.humanHitCountOf(b), 1);
        assertEq(bb.hostTipsOf(a), 0.2 ether);
        assertEq(bb.hostTipsOf(b), 1 ether);

        vm.prank(host2);
        bb.claimHost(b);
        assertEq(bb.hostClaimableOf(a), 0.2 ether, "claiming b leaves a untouched");
        vm.expectRevert(Blockbeat.NotHost.selector);
        vm.prank(host2);
        bb.claimHost(a);

        _finalize(a);
        vm.prank(host2);
        bb.finalize(b);
        assertEq(bb.claimableOf(a, alice), 0.8 ether);
        assertEq(bb.claimableOf(b, bob), 4 ether);
        assertEq(bb.claimableOf(a, bob), 0);
        vm.prank(alice);
        bb.claim(a);
        assertEq(bb.claimableOf(b, bob), 4 ether, "claiming a leaves b untouched");
        assertEq(bb.totalTipsOf(a) + bb.totalTipsOf(b), 6 ether);
    }

    // ------------------------------------------------------------------ remix

    function test_remix_childStartsWithZeroHumanHitsAndNoTips() public {
        uint256 parent = _start();
        _hits(parent, alice, 2);
        _tip(parent, 1 ether);
        _finalize(parent);
        vm.prank(bob);
        uint256 child = bb.remix(parent);
        assertEq(bb.humanHitCountOf(child), 0);
        assertEq(bb.hostTipsOf(child), 0);
        assertEq(bb.totalTipsOf(child), 0);
    }

    // ------------------------------------------------------------------ gas

    function test_gas_tipsAndHostClaim() public {
        uint256 id = _start();
        _hits(id, alice, 1);
        vm.prank(tipper);
        uint256 g0 = gasleft();
        bb.tip{value: 1 ether}(id);
        uint256 firstTip = g0 - gasleft();
        vm.prank(tipper);
        g0 = gasleft();
        bb.tip{value: 1 ether}(id);
        uint256 laterTip = g0 - gasleft();
        vm.prank(host);
        g0 = gasleft();
        bb.claimHost(id);
        uint256 hostClaim = g0 - gasleft();
        emit log_named_uint("tip (first, execution gas)", firstTip);
        emit log_named_uint("tip (later, execution gas)", laterTip);
        emit log_named_uint("claimHost (execution gas)", hostClaim);
        // Execution only (no 21k base, no calldata); the shared fixed limits add headroom
        // for Monad's cold-access repricing.
        assertLt(firstTip, 70_000);
        assertLt(hostClaim, 60_000);
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Money invariants across random human / agent hit mixes and three tips, one of
    ///      them possibly landing while only the agent had played:
    ///      host + human claims == total tipped - rounding dust, dust < number of humans,
    ///      the agent claims 0, humanHitCount <= hitCount, and the balance ends at the dust.
    function testFuzz_splitConservesEveryWei(uint8[4] memory humanHits, uint8 agentHits, uint96[3] memory tips)
        public
    {
        uint256 id = _start();
        address[4] memory humans = [makeAddr("h0"), makeAddr("h1"), makeAddr("h2"), makeAddr("h3")];
        uint256 total;

        // Phase 1: the agent opens (maybe), then an early tip that must go fully to the host.
        uint256 nAgent = uint256(agentHits) % 12;
        _hits(id, dj, nAgent);
        if (nAgent > 0 && tips[0] > 0) {
            _tip(id, tips[0]);
            total += tips[0];
            assertEq(bb.hostTipsOf(id), tips[0], "agent-only tip goes fully to the host");
            assertEq(bb.getSession(id).tipPool, 0);
        }

        // Phase 2: humans play, then a tip while live.
        uint256 humanTotal;
        uint256 nHumans;
        for (uint256 i = 0; i < 4; i++) {
            uint256 n = uint256(humanHits[i]) % 16;
            _hits(id, humans[i], n);
            humanTotal += n;
            if (n > 0) nHumans++;
        }
        vm.assume(nAgent + humanTotal > 0);
        assertEq(bb.humanHitCountOf(id), humanTotal);
        assertLe(bb.humanHitCountOf(id), bb.getSession(id).hitCount);
        if (tips[1] > 0) {
            _tip(id, tips[1]);
            total += tips[1];
        }
        _finalize(id);

        // Phase 3: everyone claims, one more tip after finalize, everyone claims again.
        uint256 paid = _claimAll(id, humans);
        if (tips[2] > 0) {
            _tip(id, tips[2]);
            total += tips[2];
        }
        paid += _claimAll(id, humans);

        assertEq(bb.claimableOf(id, dj), 0, "agent never has a claim");
        assertEq(dj.balance, 0);
        assertEq(bb.totalTipsOf(id), total);
        assertEq(bb.hostTipsOf(id) + bb.getSession(id).tipPool, total, "every tipped wei is assigned");
        assertEq(bb.hostClaimableOf(id), 0, "host is fully paid");
        assertLe(paid, total);
        uint256 dust = total - paid;
        // Each human's final payout is floor(pool * hits / humanHits): < 1 wei lost per human.
        if (nHumans == 0) assertEq(dust, 0, "with no humans the host takes everything");
        else assertLt(dust, nHumans, "only rounding dust can remain");
        assertEq(address(bb).balance, dust);
    }

    function _claimAll(uint256 id, address[4] memory humans) internal returns (uint256 paid) {
        paid += _tryClaim(id, dj, true);
        for (uint256 i = 0; i < 4; i++) {
            paid += _tryClaim(id, humans[i], false);
        }
        paid += _tryClaimHost(id);
    }

    function _tryClaim(uint256 id, address who, bool isAgent) internal returns (uint256 got) {
        uint256 before = who.balance;
        vm.prank(who);
        try bb.claim(id) {
            assertFalse(isAgent, "agent claim must revert");
            got = who.balance - before;
        } catch {}
    }

    function _tryClaimHost(uint256 id) internal returns (uint256 got) {
        uint256 before = host.balance;
        vm.prank(host);
        try bb.claimHost(id) {
            got = host.balance - before;
        } catch {}
    }
}
