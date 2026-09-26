// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Blockbeat} from "../src/Blockbeat.sol";

/// @notice Deploys Blockbeat. Usage (from contracts/, with .env populated):
///   set -a && source .env && set +a
///   forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast -vvv
/// The resident DJ agent (whose hits take no tips) comes from AGENT_ADDRESS, defaulting to
/// the testnet agent. `packages/shared` owns that address (`RESIDENT_DJ_ADDRESS`); a shared
/// test fails if the default below drifts from it.
contract Deploy is Script {
    address internal constant DEFAULT_AGENT = 0x2222222222222222222222222222222222222222;

    function run() external returns (Blockbeat blockbeat) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent = vm.envOr("AGENT_ADDRESS", DEFAULT_AGENT);

        vm.startBroadcast(deployerKey);
        blockbeat = new Blockbeat(agent);
        vm.stopBroadcast();

        console.log("Blockbeat deployed at", address(blockbeat));
        console.log("Resident DJ agent", agent);
        console.log("Deployer", vm.addr(deployerKey));
        console.log("Chain id", block.chainid);
    }
}
