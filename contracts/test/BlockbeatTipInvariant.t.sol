// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Blockbeat} from "../src/Blockbeat.sol";

/// @dev Drives one session through random sequences of hits (humans and the agent), tips,
///      finalize, player claims and host claims, and keeps ghost totals of what went in and
///      out so the invariant contract can check conservation of every wei.
contract TipHandler is Test {
    Blockbeat public immutable bb;
    address public immutable dj;
    address public immutable host;
    uint256 public immutable sessionId;

    address[4] internal humans;

    uint256 public ghostTipped;
    uint256 public ghostPaidPlayers;
    uint256 public ghostPaidHost;
    uint256 public ghostAgentPaid;

    constructor(Blockbeat _bb, address _dj, address _host, uint256 _sessionId) {
        bb = _bb;
        dj = _dj;
        host = _host;
        sessionId = _sessionId;
        humans = [makeAddr("inv-h0"), makeAddr("inv-h1"), makeAddr("inv-h2"), makeAddr("inv-h3")];
    }

    function human(uint256 i) external view returns (address) {
        return humans[i];
    }

    function hitHuman(uint256 who, uint8 note) external {
        if (bb.getSession(sessionId).finalized) return;
        vm.prank(humans[who % 4]);
        bb.hit(sessionId, 1, note % 32);
        vm.roll(block.number + 1);
    }

    function hitAgent(uint8 note) external {
        if (bb.getSession(sessionId).finalized) return;
        vm.prank(dj);
        bb.hit(sessionId, 7, note % 32);
        vm.roll(block.number + 1);
    }

    function tip(uint96 amount) external {
        if (amount == 0 || bb.getSession(sessionId).hitCount == 0) return;
        address tipper = makeAddr("inv-tipper");
        vm.deal(tipper, amount);
        bool agentOnly = bb.humanHitCountOf(sessionId) == 0;
        uint256 hostBefore = bb.hostTipsOf(sessionId);
        vm.prank(tipper);
        bb.tip{value: amount}(sessionId);
        ghostTipped += amount;
        // Checked here, where the state is known: an agent-only tip is 100 % host.
        if (agentOnly) assertEq(bb.hostTipsOf(sessionId) - hostBefore, amount, "agent-only tip fully to host");
    }

    /// @dev Rare on purpose (1 in 16 picks) so runs spend most calls in the live session.
    function finalize(uint8 seed) external {
        if (seed % 16 != 0) return;
        _finalize();
    }

    function _finalize() internal {
        if (bb.getSession(sessionId).finalized) return;
        vm.prank(host);
        bb.finalize(sessionId);
    }

    function claimPlayer(uint256 who) external {
        address player = humans[who % 4];
        uint256 before = player.balance;
        vm.prank(player);
        try bb.claim(sessionId) {
            ghostPaidPlayers += player.balance - before;
        } catch {}
    }

    function claimAgent() external {
        uint256 before = dj.balance;
        vm.prank(dj);
        try bb.claim(sessionId) {
            ghostAgentPaid += dj.balance - before;
        } catch {}
    }

    function claimHost() external {
        uint256 before = host.balance;
        vm.prank(host);
        try bb.claimHost(sessionId) {
            ghostPaidHost += host.balance - before;
        } catch {}
    }

    /// @dev Finalizes if needed, then settles everyone (host and all four humans) so the
    ///      dust bound can be checked.
    function settleAll() external {
        _finalize();
        this.claimHost();
        for (uint256 i = 0; i < 4; i++) {
            this.claimPlayer(i);
        }
    }
}

/// @notice Stateful invariants of the W21a tip split.
contract BlockbeatTipInvariantTest is Test {
    Blockbeat internal bb;
    TipHandler internal handler;
    address internal dj = makeAddr("inv-dj");
    address internal host = makeAddr("inv-host");

    function setUp() public {
        bb = new Blockbeat(dj);
        vm.roll(1_000);
        vm.prank(host);
        uint256 id = bb.startSession();
        handler = new TipHandler(bb, dj, host, id);

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = TipHandler.hitHuman.selector;
        selectors[1] = TipHandler.hitAgent.selector;
        selectors[2] = TipHandler.tip.selector;
        selectors[3] = TipHandler.finalize.selector;
        selectors[4] = TipHandler.claimPlayer.selector;
        selectors[5] = TipHandler.claimAgent.selector;
        selectors[6] = TipHandler.claimHost.selector;
        selectors[7] = TipHandler.tip.selector; // weight tips up
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev Balance == tipped - paid out, exactly (no wei created or destroyed).
    function invariant_balanceIsTippedMinusPaid() public view {
        uint256 out = handler.ghostPaidPlayers() + handler.ghostPaidHost() + handler.ghostAgentPaid();
        assertEq(address(bb).balance, handler.ghostTipped() - out);
    }

    /// @dev Every tipped wei is assigned to either the host or the players' pool.
    function invariant_hostPlusPoolEqualsTotalTipped() public view {
        uint256 id = handler.sessionId();
        assertEq(bb.hostTipsOf(id) + bb.getSession(id).tipPool, handler.ghostTipped());
        assertEq(bb.totalTipsOf(id), handler.ghostTipped());
    }

    /// @dev The host is never paid more than it earned, players never more than the pool.
    function invariant_payoutsNeverExceedShares() public view {
        uint256 id = handler.sessionId();
        assertLe(handler.ghostPaidHost(), bb.hostTipsOf(id));
        assertLe(handler.ghostPaidPlayers(), bb.getSession(id).tipPool);
        assertEq(bb.hostTipsOf(id) - handler.ghostPaidHost(), bb.hostClaimableOf(id));
    }

    function invariant_agentNeverPaid() public view {
        assertEq(handler.ghostAgentPaid(), 0);
        assertEq(bb.claimableOf(handler.sessionId(), dj), 0);
    }

    function invariant_humanHitsNeverExceedHitCount() public view {
        uint256 id = handler.sessionId();
        assertLe(bb.humanHitCountOf(id), bb.getSession(id).hitCount);
    }

    /// @dev Settle everyone at the end of each run: only floor-division dust (< 1 wei per
    ///      human) may remain, and none at all when no human ever played.
    function afterInvariant() public {
        uint256 id = handler.sessionId();
        handler.settleAll();
        uint256 dust = address(bb).balance;
        uint256 humansWithHits;
        for (uint256 i = 0; i < 4; i++) {
            if (bb.hitsOf(id, handler.human(i)) > 0) humansWithHits++;
        }
        if (humansWithHits == 0) assertEq(dust, 0, "no humans: the host took everything");
        else assertLt(dust, humansWithHits, "only rounding dust remains");
        assertEq(bb.hostClaimableOf(id), 0);
    }
}
