/**
 * Blockbeat contract ABI. Single source of truth for every app in the monorepo.
 * Mirrors docs/SDD.md §4.2. The contracts worker (W1) updates this file only if the
 * deployed interface differs, and reports the change.
 */
/** Core interface (docs/SDD.md §4.2). */
export const blockbeatCoreAbi = [
  // ---- events
  {
    type: 'event',
    name: 'SessionStarted',
    inputs: [
      { name: 'sessionId', type: 'uint256', indexed: true },
      { name: 'startBlock', type: 'uint64', indexed: false },
      { name: 'host', type: 'address', indexed: true },
      { name: 'parentSessionId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Hit',
    inputs: [
      { name: 'sessionId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'blockNumber', type: 'uint64', indexed: false },
      { name: 'step', type: 'uint8', indexed: false },
      { name: 'track', type: 'uint8', indexed: false },
      { name: 'note', type: 'uint8', indexed: false },
      { name: 'on', type: 'bool', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Tipped',
    inputs: [
      { name: 'sessionId', type: 'uint256', indexed: true },
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Finalized',
    inputs: [
      { name: 'sessionId', type: 'uint256', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'contributors', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Claimed',
    inputs: [
      { name: 'sessionId', type: 'uint256', indexed: true },
      { name: 'player', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  // ---- writes
  {
    type: 'function',
    name: 'startSession',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [{ name: 'sessionId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'remix',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'parentSessionId', type: 'uint256' }],
    outputs: [{ name: 'sessionId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'hit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'track', type: 'uint8' },
      { name: 'note', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'tip',
    stateMutability: 'payable',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'finalize',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [],
  },
  // ---- reads
  {
    type: 'function',
    name: 'pattern',
    stateMutability: 'view',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256[16]' }],
  },
  {
    type: 'function',
    name: 'stepOf',
    stateMutability: 'view',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'blockNumber', type: 'uint64' },
    ],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'getSession',
    stateMutability: 'view',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'startBlock', type: 'uint64' },
          { name: 'host', type: 'address' },
          { name: 'finalized', type: 'bool' },
          { name: 'hitCount', type: 'uint64' },
          { name: 'tokenId', type: 'uint256' },
          { name: 'parentSessionId', type: 'uint256' },
          { name: 'tipPool', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'hitsOf',
    stateMutability: 'view',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'player', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'contributorsOf',
    stateMutability: 'view',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    type: 'function',
    name: 'claimableOf',
    stateMutability: 'view',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'player', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

/**
 * Additive views and errors that exist on Blockbeat.sol beyond the SDD interface
 * (W1 added the views; the ERC721 errors are inherited from OpenZeppelin v5).
 *
 * Review H10: every `type: 'error'` entry of `forge inspect Blockbeat abi` is listed so
 * viem decodes any revert to its name (`SessionFinalized`, `NotHost`, `ZeroTip`…) instead
 * of a raw selector. Keep this in sync with contracts/src/Blockbeat.sol.
 */
export const blockbeatAbiExt = [
  { type: 'error', name: 'NoHits', inputs: [] },
  {
    type: 'error',
    name: 'ERC721NonexistentToken',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  { type: 'error', name: 'BlockBeforeStart', inputs: [] },
  { type: 'error', name: 'ERC721IncorrectOwner', inputs: [{ name: 'sender', type: 'address' }, { name: 'tokenId', type: 'uint256' }, { name: 'owner', type: 'address' }] },
  { type: 'error', name: 'ERC721InsufficientApproval', inputs: [{ name: 'operator', type: 'address' }, { name: 'tokenId', type: 'uint256' }] },
  { type: 'error', name: 'ERC721InvalidApprover', inputs: [{ name: 'approver', type: 'address' }] },
  { type: 'error', name: 'ERC721InvalidOperator', inputs: [{ name: 'operator', type: 'address' }] },
  { type: 'error', name: 'ERC721InvalidOwner', inputs: [{ name: 'owner', type: 'address' }] },
  { type: 'error', name: 'ERC721InvalidReceiver', inputs: [{ name: 'receiver', type: 'address' }] },
  { type: 'error', name: 'ERC721InvalidSender', inputs: [{ name: 'sender', type: 'address' }] },
  { type: 'error', name: 'NotHost', inputs: [] },
  { type: 'error', name: 'NoteOutOfRange', inputs: [] },
  { type: 'error', name: 'NothingToClaim', inputs: [] },
  { type: 'error', name: 'SessionFinalized', inputs: [] },
  { type: 'error', name: 'SessionNotFinalized', inputs: [] },
  { type: 'error', name: 'SessionNotFound', inputs: [] },
  { type: 'error', name: 'TrackOutOfRange', inputs: [] },
  { type: 'error', name: 'TransferFailed', inputs: [] },
  { type: 'error', name: 'ZeroTip', inputs: [] },
  {
    type: 'function',
    name: 'sessionCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenSession',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenPattern',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256[16]' }],
  },
  {
    type: 'function',
    name: 'contributorCount',
    stateMutability: 'view',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'contributorsSlice',
    stateMutability: 'view',
    inputs: [
      { name: 'sessionId', type: 'uint256' },
      { name: 'offset', type: 'uint256' },
      { name: 'limit', type: 'uint256' },
    ],
    outputs: [{ name: 'page', type: 'address[]' }],
  },
] as const;

/**
 * W21a tip split (additions only; every earlier item is unchanged): each tip pays 20 % to the
 * session host (pulled with `claimHost`) and 80 % to the players' pool (`Session.tipPool`),
 * claimed pro rata by HUMAN hits; the resident DJ `agent()` takes no tips. `Tipped` is still
 * emitted and is now followed by `TipSplit`. Generated from `forge inspect Blockbeat abi`.
 */
export const blockbeatTipSplitAbi = [
  { type: 'error', name: 'ZeroAgent', inputs: [] },
  {
    type: 'error',
    name: 'SafeCastOverflowedUintDowncast',
    inputs: [
      { name: 'bits', type: 'uint8' },
      { name: 'value', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'TipSplit',
    inputs: [
      { name: 'sessionId', type: 'uint256', indexed: true },
      { name: 'hostAmount', type: 'uint256', indexed: false },
      { name: 'poolAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'HostClaimed',
    inputs: [
      { name: 'sessionId', type: 'uint256', indexed: true },
      { name: 'host', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'claimHost',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'hostTipsOf',
    stateMutability: 'view',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'hostClaimableOf',
    stateMutability: 'view',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalTipsOf',
    stateMutability: 'view',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'humanHitCountOf',
    stateMutability: 'view',
    inputs: [{ name: 'sessionId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'agent',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'HOST_TIP_BPS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'BPS_DENOMINATOR',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** Full ABI: core interface, the additive views and errors, and the W21a tip split. */
export const blockbeatAbi = [...blockbeatCoreAbi, ...blockbeatAbiExt, ...blockbeatTipSplitAbi] as const;

export type BlockbeatAbi = typeof blockbeatAbi;
export type BlockbeatAbiExt = typeof blockbeatAbiExt;
export type BlockbeatTipSplitAbi = typeof blockbeatTipSplitAbi;
