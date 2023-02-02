# How to mine with Zebra on testnet


## Important

`s-nomp` has not been updated for NU5, so you'll need the fixes in the branches below.

These fixes disable mining pool operator payments and miner payments: they just pay to the address configured for the node.

## Install and run a mining pool

Install dependencies:
1. Install `redis` and run it on the default port: https://redis.io/docs/getting-started/
2. Install and activate `nodenv`: https://github.com/nodenv/nodenv#installation
3. Install `boost` and `libsodium` development libraries

Install `s-nomp`:
1. `git clone https://github.com/teor2345/s-nomp`
2. `cd s-nomp`
3. Use the Zebra configs: `git checkout zebra-mining`
4. Use node 8.17.0:
```sh
nodenv install 8.17.0
nodenv local 8.17.0
```
5. Update dependencies and install:
```sh
# TODO: is this needed?
export CXXFLAGS="-std=gnu++17"
npm update
npm install
```

Run `s-nomp`:
1. Edit `pool_configs/zclassic.json` so it has your Zebra port
    - TODO: change the pool name to `zcash.json`, does this work? 
3. Run `s-nomp` using `npm start`

Note: the website will log an RPC error even when it is disabled in the config. This seems like a `s-nomp` bug.

## Install a CPU or GPU miner

Install dependencies:
1. Install a statically compiled `boost` and `icu`
2. Optional: install static CUDA GPU mining libraries: https://github.com/nicehash/nheqminer#linux

Install miner:
1. `git clone https://github.com/teor2345/nheqminer`
2. `cd nheqminer`
3. Use the Zebra fixes: `git checkout zebra-mining`
4. Follow the build instructions: https://github.com/nicehash/nheqminer#general-instructions
```sh
mkdir build && cd build
# if you have CUDA installed, you can leave USE_CUDA_DJEZO on 
cmake -DUSE_CUDA_DJEZO=OFF ..
make -j $(nproc)
```

Run miner:
1. Follow the run instructions at: https://github.com/nicehash/nheqminer#run-instructions
```sh
# or use your testnet address here
./nheqminer -l 127.0.0.1:1234 -u tmRGc4CD1UyUdbSJmTUzcB6oDqk4qUaHnnh.worker1 -t 1
```
