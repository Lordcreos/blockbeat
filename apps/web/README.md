# Blockbeat web app

Next.js 16 App Router, React 19, viem, Tone.js. Pages: `/` (landing), `/host` (create a
session), `/stage/[session]` (big screen, audio, QR, host controls), `/join/[session]`
(phone pads, tip), `/track/[tokenId]` (the minted track: onchain SVG, attributes,
contributors). API routes: `POST /api/drip` (funds burners), `POST /api/session/start` and
`POST /api/session/finalize` (host key, guarded by `HOST_SECRET`).

## Run locally

Three modes, chosen by env (see the root `.env.example`; put local values in
`apps/web/.env.local`, which is gitignored):

| Mode | When | What you need |
| --- | --- | --- |
| Mock | `NEXT_PUBLIC_BLOCKBEAT_MOCK=1` (also the default on chains other than Monad testnet while the address is zero; on chain 10143 a zero address refuses to boot, review C1) | nothing; an in-memory simulator emits 300 ms blocks |
| Anvil | `NEXT_PUBLIC_CHAIN_ID=31337` plus `NEXT_PUBLIC_BLOCKBEAT_ADDRESS` | Foundry, a local anvil, the contract deployed |
| Monad testnet | `NEXT_PUBLIC_CHAIN_ID=10143` (default) once `packages/shared` holds the testnet address, or the env override | funded `DRIP_PRIVATE_KEY` and `HOST_PRIVATE_KEY` |

### Mock mode (no chain)

```sh
pnpm install
pnpm --filter web dev            # http://localhost:3000
```

### Anvil (real chain, local)

Anvil's `--block-time` takes whole seconds, so the app ships a driver that mines every
300 ms like Monad:

```sh
export PATH=$HOME/.foundry/bin:$PATH
anvil --chain-id 31337 --no-mining --port 8555 &
pnpm --filter web exec tsx test/anvil-300ms.ts --rpc http://127.0.0.1:8555 &

cd contracts
K=<anvil account 0 private key, printed in the anvil banner>
DEPLOYER_PRIVATE_KEY=$K forge script script/Deploy.s.sol:Deploy \
  --rpc-url http://127.0.0.1:8555 --broadcast --private-key $K
# → "Blockbeat deployed at 0x..."
```

`apps/web/.env.local` (anvil dev keys are public test keys, never real funds):

```sh
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_BLOCKBEAT_ADDRESS=0x...          # from the forge output
NEXT_PUBLIC_MONAD_RPC_URL=http://127.0.0.1:8555
NEXT_PUBLIC_MONAD_WS_URL=ws://127.0.0.1:8555
MONAD_RPC_URL=http://127.0.0.1:8555
DRIP_PRIVATE_KEY=<anvil account 1 key>
HOST_PRIVATE_KEY=<anvil account 2 key>
HOST_SECRET=<any string; typed once on /host>
NEXT_PUBLIC_AGENT_ADDRESS=<anvil account 3 address>
AGENT_PRIVATE_KEY=<anvil account 3 key>     # only the anvil e2e uses it
BLOCKBEAT_E2E_ANVIL=1                         # enables e2e/anvil-flow.spec.ts
```

Then `pnpm --filter web dev`, open `/host`, type the host secret, create a session, open
the stage link on the big screen and the join link on a phone.

### Monad testnet

Set `NEXT_PUBLIC_CHAIN_ID=10143` (or leave it unset), `NEXT_PUBLIC_BLOCKBEAT_ADDRESS` if
`packages/shared/src/addresses.ts` is still zero for 10143, fund the drip and host keys
from `https://faucet.monad.xyz`, and run `pnpm --filter web dev`. Explorer links on the
stage, `/host` and `/track` point at Monadscan only on this chain.

## Phones on the venue network (public URL)

Do not deploy: run everything on the stage laptop and expose port 3000 with a Cloudflare
quick tunnel. Nothing is installed globally; use the binary from
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
(or `brew install cloudflared` if you accept a global install). It is **not installed on
this machine at the time of writing** (`which cloudflared` → not found).

```sh
cloudflared tunnel --url http://localhost:3000
# prints https://<random>.trycloudflare.com
```

Put that URL in `apps/web/.env.local` as `NEXT_PUBLIC_JOIN_BASE_URL=https://<random>.trycloudflare.com`
and restart `pnpm --filter web dev`: the stage QR and short URL then point at the public
address while the stage itself stays on `localhost`. Without the variable the QR uses the
page's own origin, which is right when phones are on the same LAN as the laptop
(`NEXT_PUBLIC_JOIN_BASE_URL=http://<laptop-lan-ip>:3000` also works).

## Commands

```sh
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web test             # vitest, unit + hook tests
pnpm --filter web e2e              # playwright, mock mode; anvil-flow runs only with BLOCKBEAT_E2E_ANVIL=1
pnpm --filter web build
pnpm --filter web exec tsx test/smoke-hit.ts   # one real hit on testnet
```

## Environment variables

Documented in the root `.env.example`. Client-visible values are `NEXT_PUBLIC_*` and are
inlined at build time; `DRIP_PRIVATE_KEY`, `HOST_PRIVATE_KEY` and `HOST_SECRET` are server
only and must never be committed.

### Tips

The stage shows two codes: **Scan to play** (`/join/<session>`, hidden until the host presses
*Show join code*; the choice is kept per tab) and **Scan to tip** (`/tip/<session>`). The tip
page has its own burner (`blockbeat:tipper:pk:v1`), funded once by `POST /api/drip
{ address, mode: "tipper" }`, and offers 0.01–0.05 MON with an optional name (24) and message
(140). Messages are off chain: `POST /api/tip-note` keeps a note only when the tx receipt holds
a `Tipped` log of the Blockbeat contract for that session, one per tx, in
`apps/web/.data/tip-notes.json` (gitignored). The host pulls its 20 % with *Claim host tips*
(`POST /api/session/claim-host`, host secret); players claim their 80 % share on the phone
after the mint. Server-only variables (to add to the root `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `TIP_DRIP_AMOUNT_MON` | `0.1` | What the tipper drip sends (at most 0.5): one 0.05 tip and another after it |
| `TIP_DRIP_MAX_PER_MINUTE_PER_IP` | `20` | Tipper drips per client IP per minute, apart from the player drip |
| `TIP_DRIP_MAX_PER_MINUTE_GLOBAL` | `60` | Tipper drips per minute in total |
| `TIP_DRIP_MAX_TOTAL` | `150` | Tipper wallets funded per server lifetime (bounds the drain to 150 × amount) |
| `TIP_DRIP_MAX_PER_SESSION` | `50` | Tipper wallets per session (one actor can use up one show at most) |
| `TIP_DRIP_MAX_PER_IP_PER_SESSION` | `25` | Tipper wallets per client IP within a session |
| `TIP_NOTE_MAX_PER_MINUTE_PER_IP` | `30` | Note posts per client IP per minute |
| `TIP_NOTE_MAX_PER_MINUTE_GLOBAL` | `600` | Note posts per minute in total |
| `TIP_NOTES_FILE` | `.data/tip-notes.json` | Where the notes are kept (relative to apps/web) |
