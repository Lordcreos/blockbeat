// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Blockbeat} from "../src/Blockbeat.sol";

/// @notice Deploys Blockbeat. Usage (from contracts/, with .env populated):
///   set -a && source .env && set +a
///   forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast -vvv
contract Deploy is Script {
    function run() external returns (Blockbeat blockbeat) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        blockbeat = new Blockbeat();
        vm.stopBroadcast();

        console.log("Blockbeat deployed at", address(blockbeat));
        console.log("Deployer", vm.addr(deployerKey));
        console.log("Chain id", block.chainid);
    }
}
