// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AndxEscrow} from "../../src/AndxEscrow.sol";
import {IAndxEscrow} from "../../src/interfaces/IAndxEscrow.sol";
import {USDX, FOTX, NRT} from "../../src/tokens/MockTokens.sol";

/// @notice Ghost accounting tracked from known inputs (not copied from campaignState as expected values).
contract Handler is Test {
    AndxEscrow public immutable escrow;
    USDX public immutable usdx;
    FOTX public immutable fotx;
    NRT public immutable nrt;

    address public immutable owner;
    address public immutable operator;
    address public immutable guardian;

    address[] public brands;
    address[] public creators;
    uint256[] public creatorPks;
    bytes32[] public campaignIds;

    mapping(bytes32 => uint256) public ghostNet;
    mapping(bytes32 => uint256) public ghostActive;
    mapping(bytes32 => uint256) public ghostPending;
    mapping(bytes32 => uint256) public ghostClaimed;
    mapping(bytes32 => uint256) public ghostRefunded;
    mapping(bytes32 => address) public ghostToken;
    mapping(bytes32 => mapping(address => uint256)) public ghostClaimedBy;
    mapping(bytes32 => mapping(address => uint256)) public ghostMaxActivatedCum;
    mapping(address => mapping(uint256 => bool)) public ghostNonceUsed;

    mapping(bytes32 => mapping(address => uint256)) internal proposedCum;
    mapping(bytes32 => mapping(address => bytes32)) internal proposedSibling; // 2-leaf proof element
    mapping(bytes32 => bool) internal pendingListed;

    // Attempt vs success metrics
    uint256 public ghostClaims;
    uint256 public ghostClaimAttempts;
    uint256 public ghostActivations;
    uint256 public ghostActivationAttempts;
    uint256 public ghostRefunds;
    uint256 public ghostRefundAttempts;
    uint256 public ghostProposals;
    uint256 public ghostVetoes;

    constructor(
        AndxEscrow escrow_,
        USDX usdx_,
        FOTX fotx_,
        NRT nrt_,
        address owner_,
        address operator_,
        address guardian_
    ) {
        escrow = escrow_;
        usdx = usdx_;
        fotx = fotx_;
        nrt = nrt_;
        owner = owner_;
        operator = operator_;
        guardian = guardian_;

        brands.push(makeAddr("brand0"));
        brands.push(makeAddr("brand1"));

        for (uint256 i = 0; i < 4; ++i) {
            uint256 pk = uint256(keccak256(abi.encode("creator", i)));
            creatorPks.push(pk);
            creators.push(vm.addr(pk));
        }
    }

    function createCampaign(uint256 brandSeed, uint256 tokenSeed, uint256 amountSeed, uint256 saltSeed) external {
        address brand = brands[brandSeed % brands.length];
        address token;
        uint256 t = tokenSeed % 3;
        if (t == 0) token = address(usdx);
        else if (t == 1) token = address(fotx);
        else token = address(nrt);

        uint256 amount = bound(amountSeed, 1_000_000, 50_000_000);
        bytes32 salt = bytes32(saltSeed);

        // Independent expected received (FOTX burns 1%)
        uint256 expectedNet = token == address(fotx) ? amount - amount / 100 : amount;

        if (token == address(usdx)) usdx.mint(brand, amount);
        else if (token == address(fotx)) fotx.mint(brand, amount);
        else nrt.mint(brand, amount);

        vm.startPrank(brand);
        if (token == address(usdx)) usdx.approve(address(escrow), amount);
        else if (token == address(fotx)) fotx.approve(address(escrow), amount);
        else nrt.approve(address(escrow), amount);

        try escrow.createCampaign(token, amount, uint64(block.timestamp + 30 days), amount / 2, salt) returns (
            bytes32 id
        ) {
            ghostNet[id] = expectedNet;
            ghostToken[id] = token;
            ghostActive[id] = 0;
            ghostPending[id] = 0;
            ghostClaimed[id] = 0;
            ghostRefunded[id] = 0;
            campaignIds.push(id);
        } catch {}
        vm.stopPrank();
    }

    function proposeHonest(uint256 campaignSeed, uint256 creatorSeed, uint256 cumSeed) external {
        if (campaignIds.length == 0) return;
        bytes32 id = campaignIds[campaignSeed % campaignIds.length];
        address creator = creators[creatorSeed % creators.length];

        uint256 net = ghostNet[id];
        uint256 active = ghostActive[id];
        uint256 refunded = ghostRefunded[id];
        (,, uint64 endTime, uint256 maxEpoch,,,,,) = _viewCampaign(id);
        if (block.timestamp >= endTime) return;

        uint256 room = net - refunded - active;
        if (room == 0) return;
        uint256 maxInc = maxEpoch < room ? maxEpoch : room;
        if (maxInc == 0) return;

        uint256 already = ghostClaimedBy[id][creator];
        uint256 newCum = bound(cumSeed, 1, maxInc);
        if (newCum <= already) newCum = already + 1;
        if (newCum > active + maxInc) newCum = active + maxInc;

        uint256 newCommitted = active + (newCum > already ? newCum - already : 0);
        if (newCommitted < active) return;
        if (newCommitted - active > maxEpoch) return;
        if (newCommitted > net - refunded) return;

        bytes32 root = escrow.leaf(id, creator, newCum);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        uint256[] memory committed = new uint256[](1);
        committed[0] = newCommitted;

        (uint64 pe,,) = escrow.pendingRoot();
        if (pe != 0) return;

        uint64 epoch = uint64(escrow.lastEpoch() + 1);
        vm.prank(operator);
        try escrow.proposeRoot(epoch, root, ids, committed) {
            _markPendingListing(ids, committed);
            proposedCum[id][creator] = newCum;
            delete proposedSibling[id][creator];
            ghostProposals++;
        } catch {}
    }

    /// @dev Builds a 2-leaf adversarial tree whose leaf sums can exceed commitment.
    function proposeAdversarial(uint256 campaignSeed, uint256 committedSeed) external {
        if (campaignIds.length == 0) return;
        bytes32 id = campaignIds[campaignSeed % campaignIds.length];
        uint256 net = ghostNet[id];
        uint256 active = ghostActive[id];
        uint256 refunded = ghostRefunded[id];
        (,, uint64 endTime, uint256 maxEpoch,,,,,) = _viewCampaign(id);
        if (block.timestamp >= endTime) return;

        (uint64 pe,,) = escrow.pendingRoot();
        if (pe != 0) return;

        uint256 room = net - refunded - active;
        if (room == 0) return;
        uint256 maxInc = maxEpoch < room ? maxEpoch : room;
        if (maxInc == 0) return;
        uint256 nc = active + bound(committedSeed, 1, maxInc);

        address a = creators[0];
        address b = creators[1];
        // Each leaf asks for full `nc` → sum 2*nc > commitment; second claim should hit ceiling.
        uint256 cumA = nc;
        uint256 cumB = nc;
        bytes32 leafA = escrow.leaf(id, a, cumA);
        bytes32 leafB = escrow.leaf(id, b, cumB);
        bytes32 root = _hashPair(leafA, leafB);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        uint256[] memory committed = new uint256[](1);
        committed[0] = nc;

        uint64 epoch = uint64(escrow.lastEpoch() + 1);
        vm.prank(operator);
        try escrow.proposeRoot(epoch, root, ids, committed) {
            _markPendingListing(ids, committed);
            proposedCum[id][a] = cumA;
            proposedCum[id][b] = cumB;
            proposedSibling[id][a] = leafB;
            proposedSibling[id][b] = leafA;
            ghostProposals++;
        } catch {}
    }

    function activate() external {
        (uint64 pe,, uint64 at) = escrow.pendingRoot();
        if (pe == 0) return;
        ghostActivationAttempts++;
        if (block.timestamp < at) {
            vm.warp(at);
        }
        try escrow.activateRoot(pe) {
            for (uint256 i = 0; i < campaignIds.length; ++i) {
                bytes32 id = campaignIds[i];
                if (pendingListed[id]) {
                    ghostActive[id] = ghostPending[id];
                }
                ghostPending[id] = ghostActive[id];
                pendingListed[id] = false;
                for (uint256 j = 0; j < creators.length; ++j) {
                    uint256 pc = proposedCum[id][creators[j]];
                    if (pc > ghostMaxActivatedCum[id][creators[j]]) {
                        ghostMaxActivatedCum[id][creators[j]] = pc;
                    }
                }
            }
            ghostActivations++;
        } catch {}
    }

    function veto() external {
        (uint64 pe,,) = escrow.pendingRoot();
        if (pe == 0) return;
        vm.prank(guardian);
        try escrow.vetoRoot(pe) {
            for (uint256 i = 0; i < campaignIds.length; ++i) {
                bytes32 id = campaignIds[i];
                ghostPending[id] = ghostActive[id];
                pendingListed[id] = false;
            }
            ghostVetoes++;
        } catch {}
    }

    function claimDirect(uint256 campaignSeed, uint256 creatorSeed) external {
        if (campaignIds.length == 0) return;
        bytes32 id = campaignIds[campaignSeed % campaignIds.length];
        address creator = creators[creatorSeed % creators.length];
        uint256 cum = proposedCum[id][creator];
        if (cum == 0) return;
        if (cum <= ghostClaimedBy[id][creator]) return;

        (, bytes32 root) = escrow.activeRoot();
        if (root == bytes32(0)) return;

        bytes32 leafHash = escrow.leaf(id, creator, cum);
        bytes32[] memory proof;
        bytes32 sib = proposedSibling[id][creator];
        if (sib != bytes32(0)) {
            // 2-leaf adversarial tree
            if (_hashPair(leafHash, sib) != root) return;
            proof = new bytes32[](1);
            proof[0] = sib;
        } else {
            if (leafHash != root) return;
            proof = new bytes32[](0);
        }

        IAndxEscrow.Claim memory c =
            IAndxEscrow.Claim({campaignId: id, creator: creator, cumulativeAmount: cum});
        uint256 payout = cum - ghostClaimedBy[id][creator];
        ghostClaimAttempts++;
        vm.prank(creator);
        try escrow.claim(c, creator, proof) {
            ghostClaimedBy[id][creator] = cum;
            ghostClaimed[id] += payout;
            ghostClaims++;
        } catch {}
    }

    function claimWithSigReplay(uint256 campaignSeed, uint256 creatorSeed, uint256 nonceSeed) external {
        if (campaignIds.length == 0) return;
        bytes32 id = campaignIds[campaignSeed % campaignIds.length];
        uint256 idx = creatorSeed % creators.length;
        address creator = creators[idx];
        uint256 pk = creatorPks[idx];
        uint256 cum = proposedCum[id][creator];
        if (cum == 0 || cum <= ghostClaimedBy[id][creator]) return;
        (, bytes32 root) = escrow.activeRoot();
        if (root == bytes32(0)) return;

        bytes32 leafHash = escrow.leaf(id, creator, cum);
        bytes32[] memory proof;
        bytes32 sib = proposedSibling[id][creator];
        if (sib != bytes32(0)) {
            if (_hashPair(leafHash, sib) != root) return;
            proof = new bytes32[](1);
            proof[0] = sib;
        } else {
            if (leafHash != root) return;
            proof = new bytes32[](0);
        }

        uint256 nonce = nonceSeed;
        IAndxEscrow.ClaimAuth memory auth = IAndxEscrow.ClaimAuth({
            campaignId: id,
            creator: creator,
            cumulativeAmount: cum,
            recipient: creator,
            relayerFee: 0,
            nonce: nonce,
            deadline: block.timestamp + 1 days
        });
        bytes32 digest = escrow.hashClaimAuth(auth);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        uint256 payout = cum - ghostClaimedBy[id][creator];
        ghostClaimAttempts++;
        try escrow.claimWithSig(auth, sig, proof) {
            ghostClaimedBy[id][creator] = cum;
            ghostClaimed[id] += payout;
            ghostNonceUsed[creator][nonce] = true;
            ghostClaims++;
        } catch {}

        try escrow.claimWithSig(auth, sig, proof) {
            ghostClaims += 1000000;
        } catch {}
    }

    function refund(uint256 campaignSeed) external {
        if (campaignIds.length == 0) return;
        bytes32 id = campaignIds[campaignSeed % campaignIds.length];
        (address brand,, uint64 endTime,,,,,,) = _viewCampaign(id);
        if (brand == address(0)) return;
        if (block.timestamp < uint256(endTime) + uint256(escrow.ROOT_DELAY())) {
            vm.warp(uint256(endTime) + uint256(escrow.ROOT_DELAY()));
        }

        uint256 reserved = ghostActive[id] > ghostPending[id] ? ghostActive[id] : ghostPending[id];
        uint256 available = ghostNet[id] - ghostRefunded[id];
        uint256 expected = available > reserved ? available - reserved : 0;

        ghostRefundAttempts++;
        vm.prank(brand);
        try escrow.refundUnallocated(id) returns (uint256 amount) {
            // Independent model: refund equals ghost-predicted amount
            assertEq(amount, expected);
            if (amount > 0) {
                ghostRefunded[id] += amount;
                ghostRefunds++;
            }
        } catch {}
    }

    function warpTime(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 1, 2 days));
    }

    function campaignCount() external view returns (uint256) {
        return campaignIds.length;
    }

    function _markPendingListing(bytes32[] memory ids, uint256[] memory committed) internal {
        for (uint256 i = 0; i < campaignIds.length; ++i) {
            pendingListed[campaignIds[i]] = false;
            ghostPending[campaignIds[i]] = ghostActive[campaignIds[i]];
        }
        for (uint256 j = 0; j < ids.length; ++j) {
            pendingListed[ids[j]] = true;
            ghostPending[ids[j]] = committed[j];
        }
    }

    function _viewCampaign(bytes32 id)
        internal
        view
        returns (
            address brand,
            address token,
            uint64 endTime,
            uint256 maxCommitPerEpoch,
            uint256 netDeposited,
            uint256 activeCommitted,
            uint256 pendingCommitted_,
            uint256 claimedTotal,
            uint256 refunded
        )
    {
        return escrow.campaignState(id);
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
