// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Blockbeat} from "../src/Blockbeat.sol";

/// @notice Deploys Blockbeat. Usage (from contracts/, with .env populated):
///   set -a && source .env && set +a
///   forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast -vvv
/// The resident DJ agent (whose hits take no tips) must be supplied through AGENT_ADDRESS.
contract Deploy is Script {
    function run() external returns (Blockbeat blockbeat) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agent = vm.envAddress("AGENT_ADDRESS");

        vm.startBroadcast(deployerKey);
        blockbeat = new Blockbeat(agent);
        vm.stopBroadcast();

        console.log("Blockbeat deployed at", address(blockbeat));
        console.log("Resident DJ agent", agent);
        console.log("Deployer", vm.addr(deployerKey));
        console.log("Chain id", block.chainid);
    }
}
