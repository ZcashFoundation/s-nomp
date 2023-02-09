# How to mine with Zebra on testnet

## Important

`s-nomp` has not been updated for NU5, so you'll need the fixes in the branches below.

These fixes disable mining pool operator payments and miner payments: they just pay to the address configured for the node.

## Install, run, and sync Zebra

1. Configure `zebrad.toml`:
    * change the `network.network` config to `Testnet`
    * add your testnet transparent address in `mining.miner_address`, or you can use the ZF testnet address `t27eWDgjFYJGVXmzrXeVjnb5J3uXDM9xH9v`
    * ensure that there is an `rpc.listen_addr` in the config to enable the RPC server
    
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

## Install and run a mining pool

Install dependencies:
1. Install `redis` and run it on the default port: https://redis.io/docs/getting-started/
   On Ubuntu:
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
   On Ubuntu:
    ```sh
    sudo apt install libboost-all-dev
    sudo apt install libsodium-dev
    ```

Install `s-nomp`:
1. `git clone https://github.com/ZcashFoundation/s-nomp`
2. `cd s-nomp`
3. Use the Zebra fixes: `git checkout zebra-mining`
4. Use node 8.17.0:
    ```sh
    nodenv install 8.17.0
    nodenv local 8.17.0
    ```
    or 
    ```sh
    nvm install 8.17.0
    nvm use 8.17.0
    ```

5. Update dependencies and install:
    ```sh
    export CXXFLAGS="-std=gnu++17"
    npm update
    npm install
    ```

Run `s-nomp`:
1. Edit `pool_configs/zcash.json` so `daemons[0].port` is your Zebra port
2. Run `s-nomp` using `npm start`

Note: the website will log an RPC error even when it is disabled in the config. This seems like a `s-nomp` bug.

## Install a CPU or GPU miner

Install dependencies:
1. Install a statically compiled `boost` and `icu`
2. Optional: install static CUDA GPU mining libraries: https://github.com/nicehash/nheqminer#linux

Install miner:
1. `git clone https://github.com/ZcashFoundation/nheqminer`
2. `cd nheqminer`
3. Use the Zebra fixes: `git checkout zebra-mining`
4. Follow the build instructions: https://github.com/nicehash/nheqminer#general-instructions
```sh
mkdir build
cd build
# if you have CUDA installed, you can leave USE_CUDA_DJEZO on 
cmake -DUSE_CUDA_DJEZO=OFF ..
make -j $(nproc)
```

Run miner:
1. Follow the run instructions at: https://github.com/nicehash/nheqminer#run-instructions
```sh
# you can use your own testnet address here
# miner and pool payments are disabled, configure your address on your node to get paid
./nheqminer -l 127.0.0.1:1234 -u tmRGc4CD1UyUdbSJmTUzcB6oDqk4qUaHnnh.worker1 -t 1
```

Notes:
* A typical solution rate is 2-4 Sols/s per core
* `nheqminer` sometimes ignores Control-C, if that happens, you can quit it using:
    * `killall nheqminer`, or
    * Control-Z then `kill %1`
* Running `nheqminer` with a single thread (`-t 1`) can help avoid this issue
