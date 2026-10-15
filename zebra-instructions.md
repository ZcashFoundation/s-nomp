# How to mine with Zebra on testnet

## Important

This Zebra fork mines the daemon's `coinbasetxn` unchanged, including NU6.3 v6
transactions. **Set the pool's actual payout address in Zebra's `[mining]
miner_address`.** The s-nomp `address` is a legacy pool identity, not a payout
override. Operator/miner payment distribution remains disabled.

Nonempty `rewardRecipients`, nonempty `poolHex`, and enabled `paymentProcessing`
are rejected rather than silently ignored. Configure coinbase text at the daemon,
not the pool. See [the NU6.3 Regtest guide](#mine-on-nu63-regtest-with-zallet-payouts)
below for the required branches; the older public-testnet setup follows first.

## Install, run, and sync Zebra

1. Configure `zebrad.toml`:

    - change the `network.network` config to `Testnet`
    - add your testnet transparent address in `mining.miner_address`, or you can use the ZF testnet address `t27eWDgjFYJGVXmzrXeVjnb5J3uXDM9xH9v`
    - ensure that there is an `rpc.listen_addr` in the config to enable the RPC server

    Example config:
    <details>

    ```console
    [consensus]
    checkpoint_sync = true
    debug_skip_parameter_preload = false

    [mempool]
    eviction_memory_time = '1h'
    tx_cost_limit = 80000000

    [metrics]

    [network]
    crawl_new_peer_interval = '1m 1s'
    initial_mainnet_peers = [
        'dnsseed.z.cash:8233',
        'dnsseed.str4d.xyz:8233',
        'mainnet.seeder.zfnd.org:8233',
        'mainnet.is.yolo.money:8233',
    ]
    initial_testnet_peers = [
        'dnsseed.testnet.z.cash:18233',
        'testnet.seeder.zfnd.org:18233',
        'testnet.is.yolo.money:18233',
    ]
    listen_addr = '0.0.0.0:18233'
    network = 'Testnet'
    peerset_initial_target_size = 25

    [rpc]
    debug_force_finished_sync = false
    parallel_cpu_threads = 1
    listen_addr = '127.0.0.1:18232'

    [state]
    cache_dir = '/home/ar/.cache/zebra'
    delete_old_database = true
    ephemeral = false

    [sync]
    checkpoint_verify_concurrency_limit = 1000
    download_concurrency_limit = 50
    full_verify_concurrency_limit = 20
    parallel_cpu_threads = 0

    [tracing]
    buffer_limit = 128000
    force_use_color = false
    use_color = true
    use_journald = false

    [mining]
    miner_address = 't27eWDgjFYJGVXmzrXeVjnb5J3uXDM9xH9v'
    ```

    </details>

2. [Build](https://github.com/ZcashFoundation/zebra#build-instructions) and [Run Zebra](https://zebra.zfnd.org/user/run.html) with the `getblocktemplate-rpcs` feature:
    ```sh
    cargo run --release --features "getblocktemplate-rpcs" --bin zebrad -- -c zebrad.toml
    ```
3. Wait a few hours for Zebra to sync to the testnet tip (on mainnet this takes 2-3 days)

## Install `s-nomp`

<details><summary>General instructions with Debian/Ubuntu examples</summary>
    
#### Install dependencies

1. Install `redis` and run it on the default port: <https://redis.io/docs/getting-started/>

    ```sh
    sudo apt install lsb-release
    curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg

    echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/redis.list

    sudo apt-get update
    sudo apt-get install redis
    redis-server
    ```

2. Install and activate a node version manager (e.g. [`nodenv`](https://github.com/nodenv/nodenv#installation) or [`nvm`](https://github.com/nvm-sh/nvm#installing-and-updating))
3. Install `boost` and `libsodium` development libraries

    ```sh
    sudo apt install libboost-all-dev
    sudo apt install libsodium-dev
    ```

#### Install `s-nomp`

1. `git clone https://github.com/ZcashFoundation/s-nomp`
2. `cd s-nomp`
3. Use the Zebra fixes: `git checkout zebra-mining`
4. Use node 8.11.0:

    ```sh
    nodenv install 8.11.0
    nodenv local 8.11.0
    ```

    or

    ```sh
    nvm install 8.11.0
    nvm use 8.11.0
    ```

5. Update dependencies and install:

    ```sh
    export CXXFLAGS="-std=gnu++17"
    npm update
    npm install
    ```

</details>

<details><summary>Arch-specific instructions</summary>
    
#### Install dependencies

1. Install [`redis`](https://redis.io/docs/getting-started/) and run it on the default port:

    ```sh
    sudo pacman -S redis
    sudo systemctl start redis
    ```

2. Install and activate [`nvm`](https://github.com/nvm-sh/nvm#installing-and-updating):

    ```sh
    sudo pacman -S nvm
    unset npm_config_prefix
    source /usr/share/nvm/init-nvm.sh
    ```

3. Install `boost` and `libsodium` development libraries:

    ```sh
    sudo pacman -S boost libsodium
    ```

#### Install `s-nomp`

1. `git clone https://github.com/ZcashFoundation/s-nomp && cd s-nomp`

2. Use the Zebra configs: `git checkout zebra-mining`

3. Use node 8.11.0:

    ```sh
    nvm install 8.11.0
    nvm use 8.11.0
    ```

4. Update dependencies and install:

    ```sh
    npm update
    npm install
    ```

</details>

## Run `s-nomp`

1. Edit `pool_configs/zcash.json` so `daemons[0].port` is your Zebra port
2. Run `s-nomp` using `npm start`

Note: the website will log an RPC error even when it is disabled in the config. This seems like a `s-nomp` bug.

## Install a CPU or GPU miner

#### Install dependencies

<details><summary>General instructions</summary>

1. Install a statically compiled `boost` and `icu`.
2. Install `cmake`.

</details>

<details><summary>Arch-specific instructions</summary>

```sh
sudo pacman -S cmake boost icu
```

</details>

#### Install `nheqminer`

We're going to install `nheqminer`, which supports multiple CPU and GPU Equihash
solvers, namely `djezo`, `xenoncat`, and `tromp`. We're using `tromp` on a CPU
in the following instructions since it is the easiest to install and use.

1. `git clone https://github.com/ZcashFoundation/nheqminer`
2. `cd nheqminer`
3. Use the Zebra fixes: `git checkout zebra-mining`
4. Follow the build instructions at
   <https://github.com/nicehash/nheqminer#general-instructions>, or run:

```sh
mkdir build
cd build
# Turn off `djezo` and `xenoncat`, which are enabled by default, and turn on `tromp` instead.
cmake -DUSE_CUDA_DJEZO=OFF -DUSE_CPU_XENONCAT=OFF -DUSE_CPU_TROMP=ON ..
make -j $(nproc)
```

## Run miner

1. Follow the run instructions at: <https://github.com/nicehash/nheqminer#run-instructions>

```sh
# you can use your own testnet address here
# miner and pool payments are disabled, configure your address on your node to get paid
./nheqminer -l 127.0.0.1:1234 -u tmRGc4CD1UyUdbSJmTUzcB6oDqk4qUaHnnh.worker1 -t 1
```

Notes:

-   A typical solution rate is 2-4 Sols/s per core
-   `nheqminer` sometimes ignores Control-C, if that happens, you can quit it using:
    -   `killall nheqminer`, or
    -   Control-Z then `kill %1`
-   Running `nheqminer` with a single thread (`-t 1`) can help avoid this issue

## Mine on NU6.3 Regtest with Zallet payouts

Use disposable Regtest funds and separate node, wallet, and Redis state. Run the
services in separate terminals with the same environment variables. Keep logs and
stop only the processes started for this test. The acceptance checks below are
required before using the setup beyond Regtest; source support alone does not
demonstrate successful mining or payouts.

### Source requirements

- [s-nomp](https://github.com/ZcashFoundation/s-nomp), branch `feat/ironwood-nu6.3`.
- [stratum-pool](https://github.com/upbqdn/node-stratum-pool), branch
  `feat/ironwood-nu6.3`, including daemon-owned coinbases and external payments.
- [Zebra](https://github.com/ZcashFoundation/zebra), built from `main` with NU6.3
  Regtest activation, v6 block templates, and Ironwood coinbase support.
- [Zallet](https://github.com/zcash/wallet), with the zaino backend, NU6.3 Regtest
  parameters, Ironwood decoding/balances, and account-scoped payment RPCs:
  `z_getaccount`, `z_getaddressforaccount`, `z_listunifiedreceivers`,
  `z_getbalanceforaccount`, `z_viewtransaction`, `z_sendmany`, and
  `z_getoperationstatus`. Funding also requires `z_shieldcoinbase` and
  `regtest generate-account-and-miner-address`.

Choose a directory for your clones and set `ZALLET_REF` to a branch, tag, or commit
that provides these wallet features. Record the source revisions used for a run.

```sh
: "${ZALLET_REF:?Set ZALLET_REF to a wallet revision with the required RPCs}"
export SRC_ROOT="${SRC_ROOT:-$PWD/nu63-regtest}"
mkdir -p "$SRC_ROOT"
export SNOMP_SRC="$SRC_ROOT/s-nomp"
export STRATUM_SRC="$SRC_ROOT/node-stratum-pool"
export ZEBRA_SRC="$SRC_ROOT/zebra"
export ZALLET_SRC="$SRC_ROOT/wallet"
export MINER_SRC="$SRC_ROOT/nheqminer"
git clone --branch feat/ironwood-nu6.3 https://github.com/ZcashFoundation/s-nomp "$SNOMP_SRC"
git clone --branch feat/ironwood-nu6.3 https://github.com/upbqdn/node-stratum-pool "$STRATUM_SRC"
git clone --branch main https://github.com/ZcashFoundation/zebra "$ZEBRA_SRC"
git clone https://github.com/zcash/wallet "$ZALLET_SRC"
git -C "$ZALLET_SRC" checkout "$ZALLET_REF"
git clone --branch zebra-mining https://github.com/ZcashFoundation/nheqminer "$MINER_SRC"
```

For existing clones, set the same variables to their locations and check out the
required revisions. Use a dedicated s-nomp clone: the configuration step disables
its other pools.

### Template handling

`pool.js` obtains GBT, `jobManager.js` creates a `BlockTemplate`, and
`blockTemplate.js` copies `coinbasetxn.data` followed by every `transactions[].data`
in its original order. There is no transaction parser, coinbase-output builder,
branch-ID override or coinbase extranonce insertion. `stratum.js:handleSubmit`
concatenates the subscriber extranonce and miner nonce suffix; `serializeHeader`
writes that 32-byte nonce into the header.

Zebra's GBT `hash` is the mined txid, **not** the wtxid or `authdigest`
(`zebra-rpc/src/methods/types/transaction.rs`). The pool uses
`defaultroots.merkleroot` in serialized order; without default roots, it reverses
every leaf and computes SHA256d Merkle parents consistently.

`defaultroots.chainhistoryroot` covers the parent chain; `authdataroot` covers the
ordered transaction authorization digests; `blockcommitmentshash` combines them.
Neither the coinbase nor transaction list changes, so the daemon's commitment is
reused, not recomputed. Header bytes and `mining.notify` use the same byte order.
The header commitment prefers `blockcommitmentshash`, then the default-root field,
then the historical `finalsaplingroothash` alias.

Zebra owns NU6.3's branch ID **`37a5165b`**, v6 version group **`d884b698`**, and
coinbase construction. A NU6.3 v6 transaction starts
`06000080 98b684d8 5b16a537` (little-endian fields). No pool consensus-height table
is needed. Sources: `zebra-chain/src/parameters/{network_upgrade,transaction}.rs`,
`zebra-rpc/src/methods/types/{transaction,default_roots,get_block_template}.rs`.

### Install the pool branches

The legacy pool targets Node 8 (minimum 8.11); these commands use **8.17.0**.
Prerequisites: npm, git, compiler/make, Boost.System, libsodium development files,
GMP development files, Redis, curl and jq. Do not assume modern Node works with
the old native verifier. Its `node-gyp` dependency also has newer runtime
requirements, so check native-build compatibility when installing dependencies.

```sh
nvm install 8.17.0
nvm use 8.17.0
export CXXFLAGS="-std=gnu++17"
cd "$STRATUM_SRC"
npm install --unsafe-perm --package-lock=false
node test/blockTemplate.js
cd "$SNOMP_SRC"
npm install --unsafe-perm --no-save --package-lock=false "$STRATUM_SRC"
node -p 'require.resolve("stratum-pool")'
```

The final path must resolve to the selected stratum-pool branch (or its
npm-installed copy), not the dependency pinned by the original s-nomp lockfile.
Alternatively, install it directly from GitHub:

```sh
cd "$SNOMP_SRC"
npm install --unsafe-perm --no-save --package-lock=false \
  github:upbqdn/node-stratum-pool#feat/ironwood-nu6.3
```

These explicit installs leave the tracked dependency declaration and lockfile
unchanged. Reapply the override after an ordinary `npm install`. `npm start`
supplies the verifier library path.

The checked-in regression vector is a hash/root excerpt of a height-114 Zebra
NU5 block template with one Sapling and one transparent non-coinbase transaction.
The test computes the root without using `defaultroots`, then compares serialized
and display order. Other assertions cover opaque v5/v6 bytes, commitment selection,
and CompactSize counts. After capturing a full NU6.3 template below, also run:

```sh
cd "$STRATUM_SRC"
node test/blockTemplate.js "$RUN/funded-template.json"
```

### Build Zallet and Zebra

Zallet's **zaino backend** reads Zebra through JSON-RPC without a standalone
zainod or shared state database. Use the wallet revision's locked dependencies
and required Rust toolchain (Rust 1.95 or newer for the NU6.3 wallet).

```sh
(cd "$ZEBRA_SRC" && CARGO_TARGET_DIR=target cargo build --release --locked --bin zebrad)
(cd "$ZALLET_SRC/backends/zaino" && CARGO_TARGET_DIR=target \
  cargo build --release --locked --features rpc-cli --bin zallet-zaino)
export ZEBRAD="$ZEBRA_SRC/target/release/zebrad"
export ZALLET="$ZALLET_SRC/backends/zaino/target/release/zallet-zaino"
export RUN=$(mktemp -d "${TMPDIR:-/tmp}/snomp-ironwood.XXXXXX")
mkdir "$RUN/wallet"
```

### Matching Regtest configurations

The shared schedule activates NU5 through NU6.2 at height 1 and NU6.3 at **200**,
leaving enough time to fund Orchard first. NU7 is deliberately omitted.
For a separate all-NU6.3-at-height-1 empty/Ironwood run, change NU6.3 to 1 in
**both** configurations and use fresh node/wallet state; that run cannot fund
new Orchard notes. Keys come from Zebra's
`zebra-network/src/config.rs` and
`zebra-chain/src/parameters/network/testnet.rs::ConfiguredActivationHeights`.

```sh
cat > "$RUN/wallet/zallet.toml" <<'TOML'
backend = "zaino"
[builder.limits]
[consensus]
network = "regtest"
regtest_nuparams = [
  "5ba81b19:1", "76b809bb:1", "2bb40e60:1", "f5b9230b:1", "e9ff75a6:1",
  "c2d6d0b4:1", "c8e71055:1", "4dec4df0:1", "5437f330:1", "37a5165b:200"
]
[database]
[external]
[features]
as_of_version = "0.0.0"
[features.deprecated]
[features.experimental]
[indexer]
validator_address = "127.0.0.1:28332"
validator_user = "x"
validator_password = "x"
[keystore]
[note_management]
[rpc]
bind = ["127.0.0.1:28334"]
TOML
"$ZALLET" -d "$RUN/wallet" generate-encryption-identity
"$ZALLET" -d "$RUN/wallet" init-wallet-encryption
"$ZALLET" -d "$RUN/wallet" generate-mnemonic
export MINER_ADDRESS=$("$ZALLET" -d "$RUN/wallet" regtest generate-account-and-miner-address)
cat > "$RUN/zebrad.toml" <<TOML
[network]
network = "Regtest"
listen_addr = "127.0.0.1:28333"
initial_testnet_peers = []
[network.testnet_parameters]
funding_streams = []
[network.testnet_parameters.activation_heights]
Overwinter = 1
Sapling = 1
Blossom = 1
Heartwood = 1
Canopy = 1
NU5 = 1
NU6 = 1
"NU6.1" = 1
"NU6.2" = 1
"NU6.3" = 200
[rpc]
listen_addr = "127.0.0.1:28332"
enable_cookie_auth = false
debug_force_finished_sync = true
[state]
cache_dir = "$RUN/state-a"
[mining]
miner_address = "$MINER_ADDRESS"
TOML
"$ZEBRAD" -c "$RUN/zebrad.toml" start
# Separate terminal with the same RUN/ZALLET environment:
"$ZALLET" -d "$RUN/wallet" start
```

Use unused ports, changing every corresponding setting together. Cookie auth is
disabled only on the isolated loopback Zebra RPC; Zallet's RPC client automatically
uses its own wallet cookie. The plain age identity is for disposable funds only.
Regtest disables PoW verification by default (`Parameters::new_regtest`); the
existing miner still produces real **200,9** solutions verified by the pool.
This does not claim native Regtest **48,5** or mainnet PoW validation. The pool therefore uses
`coins/regtest/zec-200-9.json`; `coins/regtest/zec.json` is for native (48, 5) Regtest.

For peer confirmation, start a second Zebra with the same schedule, RPC 28335,
P2P 28336, `initial_testnet_peers = ["127.0.0.1:28333"]`, and
`cache_dir = "$RUN/state-b"`. Keep its miner idle. Verify it follows each accepted
pool block through native P2P rather than submitting blocks to both nodes.

### Fund Orchard before activation, Ironwood afterward

Run these Bash helpers in a terminal with the environment above. Inspect failures
before continuing. `finish_op` is bounded and saves the operation result.

```sh
zrpc() {
  curl --fail --silent --show-error -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" \
    http://127.0.0.1:28332/ |
    jq 'if .error != null then error(.error|tostring) else .result end'
}
wallet() { "$ZALLET" -d "$RUN/wallet" rpc "$@"; }
finish_op() {
  for i in $(seq 1 900); do
    wallet z_getoperationstatus "[\"$1\"]" > "$RUN/op-$1.json" || return
    case $(jq -r '.[0].status' "$RUN/op-$1.json") in
      success) wallet z_getoperationresult "[\"$1\"]"; return ;;
      failed|cancelled) cat "$RUN/op-$1.json"; return 1 ;;
    esac
    sleep 1
  done
  return 1
}
zrpc generate '[110]'
wallet getwalletstatus
# Wait for wallet_tip == node_tip before continuing (and after each generate).
ACCOUNT_O=$(wallet z_listaccounts | jq -r '.[0].account_uuid')
ACCOUNT_I=$(wallet z_getnewaccount '"Ironwood test"' | jq -r '.account_uuid')
UA_O=$(wallet z_getaddressforaccount "\"$ACCOUNT_O\"" '["orchard"]' 0 | jq -r '.address')
UA_I=$(wallet z_getaddressforaccount "\"$ACCOUNT_I\"" '["orchard"]' 0 | jq -r '.address')
OP=$(wallet z_shieldcoinbase "\"$MINER_ADDRESS\"" "\"$UA_O\"" null 1 | jq -r '.opid')
finish_op "$OP"
zrpc generate '[10]'
wallet getwalletstatus
wallet z_getbalanceforaccount "\"$ACCOUNT_O\""
# Must show spendable Orchard funds, while the node is still below height 200.
zrpc generate '[80]'
wallet getwalletstatus
# Height 200: same Orchard receiver encoding now routes new funds into Ironwood.
OP=$(wallet z_shieldcoinbase "\"$MINER_ADDRESS\"" "\"$UA_I\"" null 1 | jq -r '.opid')
finish_op "$OP"
zrpc generate '[10]'
wallet getwalletstatus
wallet z_getbalanceforaccount "\"$ACCOUNT_I\""
# Must show spendable Ironwood funds. Stop using generate for the pool-mining phase.
```

Separate accounts keep the two later transactions' inputs independent. Zebra's
consensus check `orchard_value_balance_non_negative` prohibits new Orchard inflows at
NU6.3; do not try to shield new coins into Orchard after height 200.

### Configure and run s-nomp and the CPU miner

In the dedicated s-nomp clone, generate an isolated pool configuration:

```sh
cd "$SNOMP_SRC"
cp config_example.json config.json
node <<'JS'
const fs = require('fs');
for (const file of fs.readdirSync('pool_configs').filter(f => f.endsWith('.json'))) {
  const path = 'pool_configs/' + file;
  const config = JSON.parse(fs.readFileSync(path));
  config.enabled = false;
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
}
const config = JSON.parse(fs.readFileSync('config.json'));
config.clustering.enabled = false;
config.website.enabled = false;
config.switching = {};
config.cliPort = 28339;
config.redis = {host: '127.0.0.1', port: 28379};
Object.assign(config.defaultPoolConfigs, {
  redis: config.redis, blockRefreshInterval: 250, jobRebroadcastTimeout: 30,
  validateWorkerUsername: false, poolHex: '', banning: {enabled: false}
});
fs.writeFileSync('config.json', JSON.stringify(config, null, 2) + '\n');
fs.writeFileSync('pool_configs/zcash_regtest.json', JSON.stringify({
  enabled: true, coin: 'regtest/zec-200-9.json', address: process.env.MINER_ADDRESS,
  rewardRecipients: {}, paymentProcessing: {enabled: false,
    daemon: {host: '127.0.0.1', port: 28332, user: 'x', password: 'x'}},
  ports: {'28337': {tls: false, diff: 0.0009765625}},
  daemons: [{host: '127.0.0.1', port: 28332, user: 'x', password: 'x'}]
}, null, 2) + '\n');
JS
redis-server --bind 127.0.0.1 --port 28379 --save "" --appendonly no
# Separate terminal:
npm start
```

The **actual payout remains `$MINER_ADDRESS` in zebrad.toml**, not the pool JSON.
No variable difficulty is configured. A 30-second rebroadcast interval limits
nonce-search resets. Stratum binds all interfaces in this implementation:
isolate/firewall its port; do not expose this test pool.

Build the Zcash Foundation `nheqminer` CPU miner from the clone above:

```sh
cmake -S "$MINER_SRC" -B "$MINER_SRC/build-ironwood" \
  -DUSE_CPU_XENONCAT=OFF -DUSE_CPU_TROMP=ON -DUSE_CUDA_DJEZO=OFF -DUSE_CUDA_TROMP=OFF
cmake --build "$MINER_SRC/build-ironwood" -j4
"$MINER_SRC/build-ironwood/nheqminer" \
  -l 127.0.0.1:28337 -u "$MINER_ADDRESS.worker1" -t 1 > "$RUN/miner.log" 2>&1 &
MINER_PID=$!
```

Capture its PID for `kill -STOP "$MINER_PID"` / `kill -CONT "$MINER_PID"` in the
funded phase. Do not use process-name-wide kill commands.

### Acceptance observations

1. **Empty NU6.3:** require an empty mempool/GBT, capture GBT, and let the pool
   produce two accepted blocks. Save the actual `submitblock` request/response,
   block hashes and both nodes' `getblock` output. Coinbase must be v6, branch
   `37a5165b`, and byte-for-byte equal to the matching-parent GBT coinbase.
2. Pause only the miner. Create the following real transactions and wait for both
   operations to succeed; do not call `generate` while they are pending:

   ```sh
   OP_O=$(wallet z_sendmany "\"$UA_O\"" \
     "[{\"address\":\"$UA_I\",\"amount\":0.001}]" 1 null '"AllowRevealedAmounts"')
   finish_op "$OP_O" > "$RUN/orchard-send.json"
   OP_I=$(wallet z_sendmany "\"$UA_I\"" \
     "[{\"address\":\"$UA_O\",\"amount\":0.002}]" 1 null '"FullPrivacy"')
   finish_op "$OP_I" > "$RUN/ironwood-send.json"
   zrpc getrawmempool '[]'
   zrpc getblocktemplate '[{}]' > "$RUN/funded-template.json"
   ```

   Decode each resulting txid with `wallet getrawtransaction "\"$TXID\"" 1`.
   Require v6 for the Ironwood transaction, nonempty `ironwood.actions`, and a
   nonempty `orchard.actions` in the migration transaction. Retain raw bytes and
   decoded JSON. Check both txids occur in GBT `transactions[].hash` with fees.
3. Run the capture-based serialization test above, and wait for a Stratum job
   whose Merkle root equals the captured GBT root in serialized order. Same-parent
   transaction refresh can wait until the 30-second rebroadcast.
4. Resume the CPU miner. Require Zebra's successful `submitblock` result plus block
   lookup on A and native-P2P visibility on B. The accepted funded block must
   include **both** transaction IDs. Its coinbase/body order must match one captured
   GBT for that parent, and its header roots must match that template.
5. Record fees, height, branch/version, action counts, binary/source identities,
   job bytes, RPC bytes, acceptance/rejection reasons, and peer tip. A share accepted
   by s-nomp, a rising height from `generate`, or a pool success log is not proof
   of accepted pool mining.
6. Submit a block with an incorrect Merkle root and require rejection. Replay a
   stale share and confirm it cannot create another accepted block. Keep the
   exact-root and transaction-inclusion checks enabled.

