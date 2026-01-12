#!/bin/bash
set -e

# Default values
ZEBRA_HOST="${ZEBRA_HOST:-127.0.0.1}"
ZEBRA_RPC_PORT="${ZEBRA_RPC_PORT:-18232}"
REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
STRATUM_PORT="${STRATUM_PORT:-3333}"
NETWORK="${NETWORK:-Testnet}"

# Select coin file based on network
if [ "$NETWORK" = "Mainnet" ]; then
    COIN_FILE="zec.json"
else
    COIN_FILE="testnet/zec.json"
fi

# Generate config.json
cat > /app/config.json << EOF
{
    "logLevel": "debug",
    "logColors": true,
    "cliPort": 17117,
    "clustering": { "enabled": false },
    "defaultPoolConfigs": {
        "blockRefreshInterval": 500,
        "jobRebroadcastTimeout": 55,
        "connectionTimeout": 600,
        "emitInvalidBlockHashes": false,
        "validateWorkerUsername": false,
        "banning": {
            "enabled": true,
            "time": 600,
            "invalidPercent": 50,
            "checkThreshold": 500
        },
        "redis": {
            "host": "${REDIS_HOST}",
            "port": 6379,
            "password": ""
        }
    },
    "website": {
        "enabled": true,
        "host": "0.0.0.0",
        "port": 8080,
        "stats": {
            "updateInterval": 15,
            "historicalRetention": 14400,
            "hashrateWindow": 300
        }
    },
    "redis": {
        "host": "${REDIS_HOST}",
        "port": 6379,
        "password": ""
    }
}
EOF

# Remove any existing pool configs to avoid conflicts
rm -f /app/pool_configs/*.json

# Generate pool config
cat > /app/pool_configs/zcash.json << EOF
{
    "enabled": true,
    "coin": "${COIN_FILE}",
    "address": "tmRGc4CD1UyUdbSJmTUzcB6oDqk4qUaHnnh",
    "_comment_address": "Ignored - all rewards go to Zebra miner_address",
    "paymentProcessing": {
        "enabled": false,
        "daemon": {
            "host": "${ZEBRA_HOST}",
            "port": ${ZEBRA_RPC_PORT},
            "user": "x",
            "password": "x"
        }
    },
    "ports": {
        "${STRATUM_PORT}": {
            "diff": 0.05,
            "varDiff": {
                "minDiff": 0.04,
                "maxDiff": 16384,
                "targetTime": 15,
                "retargetTime": 60,
                "variancePercent": 30
            }
        }
    },
    "daemons": [{
        "host": "${ZEBRA_HOST}",
        "port": ${ZEBRA_RPC_PORT},
        "user": "x",
        "password": "x"
    }]
}
EOF

echo "Generated config.json with Redis at ${REDIS_HOST}:6379"
echo "Generated pool config for ${NETWORK} with Zebra at ${ZEBRA_HOST}:${ZEBRA_RPC_PORT}"
echo "Stratum port: ${STRATUM_PORT}"

# Start Redis if REDIS_HOST is localhost (standalone mode)
if [ "$REDIS_HOST" = "127.0.0.1" ] || [ "$REDIS_HOST" = "localhost" ]; then
    echo "Starting local Redis server..."
    redis-server --daemonize yes
fi

exec "$@"
