var fs = require('fs');
var request = require('request');

var redis = require('redis');
var async = require('async');

var Stratum = require('stratum-pool');
var util = require('stratum-pool/lib/util.js');
var CreateRedisClient = require('./createRedisClient.js');

let badBlocks = {}

module.exports = function(logger){

    var poolConfigs = JSON.parse(process.env.pools);

    var enabledPools = [];

    Object.keys(poolConfigs).forEach(function(coin) {
        var poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing &&
            poolOptions.paymentProcessing.enabled)
            enabledPools.push(coin);
    });

    async.filter(enabledPools, function(coin, callback){
        SetupForPool(logger, poolConfigs[coin], function(setupResults){
            callback(null, setupResults);
        });
    }, function(err, results){
        results.forEach(function(coin){

            var poolOptions = poolConfigs[coin];
            var processingConfig = poolOptions.paymentProcessing;
            var logSystem = 'Payments';
            var logComponent = coin;

            logger.debug(logSystem, logComponent, 'Payment processing setup with daemon ('
                + processingConfig.daemon.user + '@' + processingConfig.daemon.host + ':' + processingConfig.daemon.port
                + ') and redis ('
                + ((typeof poolOptions.redis.socket !== "undefined" && poolOptions.redis.socket !== "")
                    ? poolOptions.redis.socket
                    : (poolOptions.redis.host + ':' + poolOptions.redis.port))
                + ')');
        });
    });
};

function SetupForPool(logger, poolOptions, setupFinished){


    var coin = poolOptions.coin.name;
    var processingConfig = poolOptions.paymentProcessing;
    var useZallet = processingConfig.wallet === 'zallet';

    var logSystem = 'Payments';
    var logComponent = coin;

    var opidCount = 0;
    var opids = [];

    // zcash team recommends 10 confirmations for safety from orphaned blocks
    var minConfShield = Math.max((processingConfig.minConf || 10), 1); // Don't allow 0 conf transactions.
    var minConfPayout = Math.max((processingConfig.minConf || 10), 1);
    if (minConfPayout  < 3) {
        logger.warning(logSystem, logComponent, logComponent + ' minConf of 3 is recommended.');
    }

    // minimum paymentInterval of 60 seconds
    var paymentIntervalSecs = Math.max((processingConfig.paymentInterval || 120), 30);
    if (parseInt(processingConfig.paymentInterval) < 120) {
        logger.warning(logSystem, logComponent, ' minimum paymentInterval of 120 seconds recommended.');
    }

    var maxBlocksPerPayment =  Math.max(processingConfig.maxBlocksPerPayment || 3, 1);

    // pplnt - pay per last N time shares
    var pplntEnabled = processingConfig.paymentMode === "pplnt" || false;
    var pplntTimeQualify = processingConfig.pplnt || 0.51; // 51%

    var getMarketStats = poolOptions.coin.getMarketStats === true;
    // Zebra already constructs the shielded coinbase; Zallet never runs the legacy sweep.
    var requireShielding = !useZallet && poolOptions.coin.requireShielding === true;
    var fee = parseFloat(poolOptions.coin.txfee) || parseFloat(0.0004);

    logger.debug(logSystem, logComponent, logComponent + ' requireShielding: ' + requireShielding);
    logger.debug(logSystem, logComponent, logComponent + ' minConf: ' + minConfShield);
    logger.debug(logSystem, logComponent, logComponent + ' payments txfee reserve: ' + fee);
    logger.debug(logSystem, logComponent, logComponent + ' maxBlocksPerPayment: ' + maxBlocksPerPayment);
    logger.debug(logSystem, logComponent, logComponent + ' PPLNT: ' + pplntEnabled + ', time period: '+pplntTimeQualify);

    var daemon = new Stratum.daemon.interface([processingConfig.daemon], function(severity, message){
        logger[severity](logSystem, logComponent, message);
    });
    var miningDaemon = useZallet ? new Stratum.daemon.interface([poolOptions.daemons[0]], function(severity, message){
        logger[severity](logSystem, logComponent, message);
    }) : daemon;
    var redisClient = CreateRedisClient(poolOptions.redis);
    // redis auth if enabled
    if (poolOptions.redis.password) {
        redisClient.auth(poolOptions.redis.password);
    }

    var magnitude;
    var minPaymentSatoshis;
    var coinPrecision;

    var paymentInterval;
    var paymentRunning = false;
    var pendingPayment;
    var pendingPaymentKey = coin + ':paymentProcessing:pending';
    var rewardAddress;
    var spendPools;

    // Zallet requires JSON-RPC 2.0. Keep the legacy daemon transport for zcashd.
    function walletRpc(method, params, callback) {
        var rpc = processingConfig.daemon;
        request.post({
            url: require('url').format({protocol: 'http:', hostname: rpc.host || '127.0.0.1', port: rpc.port, pathname: '/'}),
            auth: {user: rpc.user, pass: rpc.password},
            json: {jsonrpc: '2.0', id: 1, method: method, params: params},
            followRedirect: false,
            timeout: 60000
        }, function(error, response, body) {
            if (error || !response || response.statusCode !== 200 || !body ||
                body.id !== 1 || body.error || !Object.prototype.hasOwnProperty.call(body, 'result')) {
                return callback(new Error(method + ': ' + (error ? error.message : JSON.stringify(body))));
            }
            callback(null, body.result);
        });
    }

    function zalletBalance(callback) {
        walletRpc('z_getbalanceforaccount', [processingConfig.account, minConfPayout], function(error, balance) {
            if (error) return callback(error);
            if (!balance || !balance.pools || balance.minimum_confirmations !== minConfPayout)
                return callback(new Error('Invalid Zallet account balance'));
            var total = 0;
            for (var i = 0; i < spendPools.length; i++) {
                var pool = balance.pools[spendPools[i]];
                if (!pool) continue; // Zallet omits zero balances.
                if (!Number.isSafeInteger(pool.valueZat) || pool.valueZat < 0)
                    return callback(new Error('Invalid Zallet valueZat'));
                total += pool.valueZat;
            }
            if (!Number.isSafeInteger(total)) return callback(new Error('Zallet balance overflow'));
            callback(null, total);
        });
    }

    function setupZallet(callback) {
        magnitude = 100000000;
        coinPrecision = 8;
        minPaymentSatoshis = Math.round(processingConfig.minimumPayment * magnitude);
        if (typeof processingConfig.account !== 'string' || !processingConfig.address ||
            !Number.isSafeInteger(minPaymentSatoshis) || minPaymentSatoshis <= 0 ||
            !Number.isInteger(minConfPayout) || !Number.isInteger(maxBlocksPerPayment) ||
            !Number.isFinite(fee) || fee <= 0) {
            return callback(new Error('Zallet requires account UUID, address, and positive payment settings'));
        }
        walletRpc('z_getaccount', [processingConfig.account], function(error, account) {
            if (error) return callback(error);
            if (!account || account.account_uuid !== processingConfig.account || !Array.isArray(account.addresses))
                return callback(new Error('Zallet account UUID mismatch'));
            var address = processingConfig.address;
            var known = account.addresses.find(function(a) { return a.ua === address || a.sapling === address; });
            if (!known)
                return callback(new Error('paymentProcessing.address must be a shielded address of the pool account'));
            if (known.sapling === address) {
                rewardAddress = address;
                spendPools = ['sapling'];
                return callback();
            }
            walletRpc('z_listunifiedreceivers', [address], function(error, receivers) {
                if (error) return callback(error);
                if (!receivers || (!receivers.orchard && !receivers.sapling))
                    return callback(new Error('Pool Unified Address has no shielded receiver'));
                // Zebra prefers Orchard receivers (Ironwood after NU6.3), then Sapling.
                rewardAddress = receivers.orchard || receivers.sapling;
                spendPools = receivers.orchard ? ['orchard', 'ironwood'] : [];
                if (receivers.sapling) spendPools.push('sapling');
                callback();
            });
        });
    }

    function zalletTransactions(rounds, callback) {
        async.mapLimit(rounds, 4, function(round, next) {
            walletRpc('z_viewtransaction', [round.txHash], function(error, tx) {
                if (error) return next(error); // Wallet lag is not evidence of an invalid block.
                if (!tx || tx.txid !== round.txHash || tx.generated !== true ||
                    !Number.isInteger(tx.confirmations) || !Array.isArray(tx.outputs))
                    return next(new Error('Invalid Zallet coinbase details for ' + round.txHash));
                if (tx.status !== 'mined' || tx.blockhash !== round.blockHash)
                    return next(new Error('Coinbase not in the wallet main chain: ' + round.txHash));
                var reward = 0;
                tx.outputs.forEach(function(output) {
                    if (output.account_uuid === processingConfig.account && output.address === rewardAddress &&
                        output.outgoing === false && output.walletInternal === false) {
                        reward += Number.isSafeInteger(output.valueZat) && output.valueZat >= 0 ? output.valueZat : NaN;
                    }
                });
                if (!Number.isSafeInteger(reward) || reward <= coinsToSatoshies(fee))
                    return next(new Error('Missing or invalid reward to the configured pool address: ' + round.txHash));
                var confirmations = Math.max(100, minConfPayout,
                    (poolOptions.coin.poolOptions || {}).confirmations || 100);
                next(null, {result: {
                    confirmations: tx.confirmations,
                    details: [{address: poolOptions.address, amount: satoshisToCoins(reward),
                        category: tx.confirmations >= confirmations ? 'generate' : 'immature'}]
                }});
            });
        }, function(error, results) {
            // Preserve the existing round/account callback shape without calling getaccount.
            callback(error, error ? null : results.concat([{result: ''}]));
        });
    }

    function savePendingPayment(callback) {
        redisClient.set(pendingPaymentKey, JSON.stringify(pendingPayment), callback);
    }

    function stopZalletPayments(error, callback) {
        clearInterval(paymentInterval);
        logger.error(logSystem, logComponent, 'Zallet payments stopped: ' + error.message +
            '. Reconcile ' + pendingPaymentKey + ' before restarting; never blindly delete a pending send.');
        callback(error);
    }

    function sendZallet(addressAmounts, workers, rounds, callback) {
        pendingPayment = {account: processingConfig.account, address: processingConfig.address,
            amounts: addressAmounts, workers: workers, rounds: rounds, created: Date.now()};
        // No expiry: losing the send response or restarting must never permit a second send.
        redisClient.setnx(pendingPaymentKey, JSON.stringify(pendingPayment), function(error, acquired) {
            if (error || acquired !== 1)
                return stopZalletPayments(error || new Error('Unreconciled payment already exists'), callback);
            var amounts = Object.keys(addressAmounts).map(function(address) {
                return {address: address, amount: addressAmounts[address]};
            });
            walletRpc('z_sendmany', [processingConfig.address, amounts, minConfPayout, null, 'NoPrivacy'],
                function(error, opid) {
                    if (error || typeof opid !== 'string' || !/^opid-[0-9a-f-]{36}$/.test(opid))
                        return stopZalletPayments(error || new Error('Missing Zallet operation id'), callback);
                    pendingPayment.opid = opid;
                    savePendingPayment(function(error) {
                        if (error) return stopZalletPayments(error, callback);
                        poll();
                    });
                });
            function poll() {
                walletRpc('z_getoperationstatus', [[pendingPayment.opid]], function(error, operations) {
                    if (error) return stopZalletPayments(error, callback);
                    if (!Array.isArray(operations) || operations.length !== 1 || operations[0].id !== pendingPayment.opid)
                        return stopZalletPayments(new Error('Missing Zallet operation status'), callback);
                    var operation = operations[0];
                    if (operation.status === 'queued' || operation.status === 'executing') {
                        if (Date.now() - pendingPayment.created >= 3600000)
                            return stopZalletPayments(new Error('Zallet operation exceeded one hour'), callback);
                        return setTimeout(poll, 5000);
                    }
                    var result = operation.result;
                    if (operation.status !== 'success' || !result || result.broadcast !== true ||
                        !Array.isArray(result.txids) || result.txids.length === 0 ||
                        !result.txids.every(function(txid) { return typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid); })) {
                        // A failed multi-transaction operation can already have broadcast a prefix.
                        return stopZalletPayments(new Error('Unconfirmed Zallet send outcome: ' + JSON.stringify(operation)), callback);
                    }
                    pendingPayment.result = result;
                    savePendingPayment(function(error) {
                        if (error) return stopZalletPayments(error, callback);
                        callback(null, {response: result.txids[result.txids.length - 1], txids: result.txids});
                    });
                });
            }
        });
    }

    function validateAddress (callback){
        daemon.cmd('validateaddress', [poolOptions.address], function(result) {
            if (result.error){
                logger.error(logSystem, logComponent, 'Error with payment processing daemon (validateAddress) ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else{
                callback()
            }
        }, true);
    }
    function validateTAddress (callback) {
        daemon.cmd('validateaddress', [poolOptions.tAddress], function(result) {
            if (result.error){
                logger.error(logSystem, logComponent, 'Error with payment processing daemon (validateTAddress) ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else{
                callback()
            }
        }, true);
     }
     function validateZAddress (callback) {
        daemon.cmd('z_validateaddress', [poolOptions.zAddress], function(result) {
            if (result.error){
                logger.error(logSystem, logComponent, 'Error with payment processing daemon (validateZAddress) ' + JSON.stringify(result.error));
                callback(true);
            }
            else if (!result.response || !result.response.ismine) {
                logger.error(logSystem, logComponent,
                    'Daemon does not own pool address - payment processing can not be done with this daemon, '
                    + JSON.stringify(result.response));
                callback(true);
            }
            else{
                callback()
            }
        }, true);
    }
    function getBalance(callback){
        daemon.cmd('getbalance', [], function(result){
            if (result.error){
                return callback(true);
            }
            try {
                var d = result.data.split('result":')[1].split(',')[0].split('.')[1];
                magnitude = parseInt('10' + new Array(d.length).join('0'));
                minPaymentSatoshis = parseInt(processingConfig.minimumPayment * magnitude);
                coinPrecision = magnitude.toString().length - 1;
            }
            catch(e){
                logger.error(logSystem, logComponent, 'Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: ' + result.data);
                return callback(true);
            }
            callback();
        }, true, true);
    }

    function asyncComplete(err){
        if (err){
            if (useZallet) logger.error(logSystem, logComponent, 'Zallet setup failed: ' + err.message);
            setupFinished(false);
            return;
        }
        if (paymentInterval) {
            clearInterval(paymentInterval);
        }
        paymentInterval = setInterval(processPayments, paymentIntervalSecs * 1000);
        //setTimeout(processPayments, 100);
        setupFinished(true);
    }

    if (useZallet) {
        setupZallet(asyncComplete);
    } else if (requireShielding === true) {
        async.parallel([validateAddress, validateTAddress, validateZAddress, getBalance], asyncComplete);
    } else {
        async.parallel([validateAddress, validateTAddress, getBalance], asyncComplete);
    }

    //get t_address coinbalance
    function listUnspent (addr, notAddr, minConf, displayBool, callback) {
        if (useZallet) return zalletBalance(callback);
        if (addr !== null) {
            var args = [minConf, 99999999, [addr]];
        } else {
            addr = 'Payout wallet';
            var args = [minConf, 99999999];
        }
        daemon.cmd('listunspent', args, function (result) {
            if (!result || result.error || result[0].error) {
                logger.error(logSystem, logComponent, 'Error with RPC call listunspent '+addr+' '+JSON.stringify(result[0].error));
                callback = function (){};
                callback(true);
            }
            else {
                var tBalance = parseFloat(0);
                if (result[0].response != null && result[0].response.length > 0) {
                    for (var i = 0, len = result[0].response.length; i < len; i++) {
                        if (result[0].response[i].address && result[0].response[i].address !== notAddr) {
                            tBalance += parseFloat(result[0].response[i].amount || 0);
                        }
                    }
                    tBalance = coinsRound(tBalance);
                }
                if (displayBool === true) {
                    logger.special(logSystem, logComponent, addr+' balance of ' + tBalance);
                }
                callback(null, coinsToSatoshies(tBalance));
            }
        });
    }

    // get z_address coinbalance
    function listUnspentZ (addr, minConf, displayBool, callback) {
        daemon.cmd('z_getbalance', [addr, minConf], function (result) {
            if (!result || result.error || result[0].error) {
                logger.error(logSystem, logComponent, 'Error with RPC call z_getbalance '+addr+' '+JSON.stringify(result[0].error));
                callback = function (){};
                callback(true);
            }
            else {
                var zBalance = parseFloat(0);
                if (result[0].response != null) {
                    zBalance = coinsRound(result[0].response);
                }
                if (displayBool === true) {
                    logger.special(logSystem, logComponent, addr.substring(0,14) + '...' + addr.substring(addr.length - 14) + ' balance: '+(zBalance).toFixed(8));
                }
                callback(null, coinsToSatoshies(zBalance));
            }
        });
    }

    //send t_address balance to z_address
    function sendTToZ (callback, tBalance) {
        if (callback === true)
            return;
        if (tBalance === NaN) {
            logger.error(logSystem, logComponent, 'tBalance === NaN for shieldcoinbase');
            return;
        }
        if ((tBalance - 10000) <= 0)
            return;

        // do not allow more than a single z_shieldcoinbase operation at a time
        if (opidCount > 0) {
            logger.warning(logSystem, logComponent, 'shieldcoinbase is waiting, too many operations already in progress.');
            return;
        }

        var amount = satoshisToCoins(tBalance - 10000);
        var params = [poolOptions.address, poolOptions.zAddress];
        daemon.cmd('z_shieldcoinbase', params,
            function (result) {
                //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                if (!result || result.error || result[0].error || !result[0].response) {
                    logger.error(logSystem, logComponent, 'Error trying to shield balance '+amount+' '+JSON.stringify(result[0].error));
                    callback = function (){};
                    callback(true);
                }
                else {
                    var opid = (result.response || result[0].response);
                    opidCount++;
                    opids.push(opid);
                    logger.special(logSystem, logComponent, 'Shielding balance ' + amount);
                    callback = function (){};
                    callback(null);
                }
            }
        );
    }

    // send z_address balance to t_address
    function sendZToT (callback, zBalance) {
        if (callback === true)
            return;
        if (zBalance === NaN) {
            logger.error(logSystem, logComponent, 'zBalance === NaN for sendZToT');
            return;
        }
        if ((zBalance - 10000) <= 0)
            return;

        // do not allow more than a single z_sendmany operation at a time
        if (opidCount > 0) {
            logger.warning(logSystem, logComponent, 'sendZToT is waiting, too many z_sendmany operations already in progress.');
            return;
        }

        var amount = satoshisToCoins(zBalance - 10000);

        var params = [poolOptions.zAddress, [{'address': poolOptions.tAddress, 'amount': amount}]];
        daemon.cmd('z_sendmany', params,
            function (result) {
                //Check if payments failed because wallet doesn't have enough coins to pay for tx fees
                if (!result || result.error || result[0].error || !result[0].response) {
                    logger.error(logSystem, logComponent, 'Error trying to send z_address coin balance to payout t_address.'+JSON.stringify(result[0].error));
                    callback = function (){};
                    callback(true);
                }
                else {
                    var opid = (result.response || result[0].response);
                    opidCount++;
                    opids.push(opid);
                    logger.special(logSystem, logComponent, 'Unshield funds for payout ' + amount + ' ' + opid);
                    callback = function (){};
                    callback(null);
                }
            }
        );
    }

    function cacheMarketStats() {
        var marketStatsUpdate = [];
        var coin = logComponent.replace('_testnet', '').toLowerCase();
        if (coin == 'zen')
            coin = 'zencash';

        request('https://api.coinmarketcap.com/v1/ticker/'+coin+'/', function (error, response, body) {
            if (error) {
                logger.error(logSystem, logComponent, 'Error with http request to https://api.coinmarketcap.com/ ' + JSON.stringify(error));
                return;
            }
            if (response && response.statusCode) {
                if (response.statusCode == 200) {
                    if (body) {
                        var data = JSON.parse(body);
                        if (data.length > 0) {
                            marketStatsUpdate.push(['hset', logComponent + ':stats', 'coinmarketcap', JSON.stringify(data)]);
                            redisClient.multi(marketStatsUpdate).exec(function(err, results){
                                if (err){
                                    logger.error(logSystem, logComponent, 'Error with redis during call to cacheMarketStats() ' + JSON.stringify(error));
                                    return;
                                }
                            });
                        }
                    }
                } else {
                    logger.error(logSystem, logComponent, 'Error, unexpected http status code during call to cacheMarketStats() ' + JSON.stringify(response.statusCode));
                }
            }
        });
    }

    function cacheNetworkStats () {
        var params = null;
        miningDaemon.cmd('getmininginfo', params,
            function (result) {
                if (!result || result.error || result[0].error || !result[0].response) {
                    logger.error(logSystem, logComponent, 'Error with RPC call getmininginfo '+JSON.stringify(result[0].error));
                    return;
                }

                var coin = logComponent;
                var finalRedisCommands = [];

                if (result[0].response.blocks !== null) {
                    finalRedisCommands.push(['hset', coin + ':stats', 'networkBlocks', result[0].response.blocks]);
                }
                if (result[0].response.difficulty !== null) {
                    finalRedisCommands.push(['hset', coin + ':stats', 'networkDiff', result[0].response.difficulty]);
                }
                if (result[0].response.networkhashps !== null) {
                    finalRedisCommands.push(['hset', coin + ':stats', 'networkSols', result[0].response.networkhashps]);
                }

                miningDaemon.cmd('getnetworkinfo', params,
                    function (result) {
                        if (!result || result.error || result[0].error || !result[0].response) {
                            logger.error(logSystem, logComponent, 'Error with RPC call getnetworkinfo '+JSON.stringify(result[0].error));
                            return;
                        }

                        if (result[0].response.connections !== null) {
                            finalRedisCommands.push(['hset', coin + ':stats', 'networkConnections', result[0].response.connections]);
                        }
                        if (result[0].response.version !== null) {
                            finalRedisCommands.push(['hset', coin + ':stats', 'networkVersion', result[0].response.version]);
                        }
                        if (result[0].response.subversion !== null) {
                            finalRedisCommands.push(['hset', coin + ':stats', 'networkSubVersion', result[0].response.subversion]);
                        }
                        if (result[0].response.protocolversion !== null) {
                            finalRedisCommands.push(['hset', coin + ':stats', 'networkProtocolVersion', result[0].response.protocolversion]);
                        }

                        if (finalRedisCommands.length <= 0)
                            return;

                        redisClient.multi(finalRedisCommands).exec(function(error, results){
                            if (error){
                                logger.error(logSystem, logComponent, 'Error with redis during call to cacheNetworkStats() ' + JSON.stringify(error));
                                return;
                            }
                        });
                    }
                );
            }
        );
    }

    // run shielding process every x minutes
    var shieldIntervalState = 0; // do not send ZtoT and TtoZ and same time, this results in operation failed!
    var shielding_interval = Math.max(parseInt(poolOptions.walletInterval || 1), 1) * 60 * 1000; // run every x minutes
    // shielding not required for some equihash coins
    if (requireShielding === true) {
        var shieldInterval = setInterval(function() {
            shieldIntervalState++;
            switch (shieldIntervalState) {
                case 1:
                    listUnspent(poolOptions.address, null, minConfShield, false, sendTToZ);
                    break;
                default:
                    listUnspentZ(poolOptions.zAddress, minConfShield, false, sendZToT);
                    shieldIntervalState = 0;
                    break;
            }
        }, shielding_interval);
    }

    // network stats caching every 58 seconds
    var stats_interval = 58 * 1000;
    var statsInterval = setInterval(function() {
        // update network stats using coin daemon
        cacheNetworkStats();
    }, stats_interval);

    // market stats caching every 5 minutes
    if (getMarketStats === true) {
        var market_stats_interval = 300 * 1000;
        var marketStatsInterval = setInterval(function() {
            // update market stats using coinmarketcap
            cacheMarketStats();
        }, market_stats_interval);
    }

    // check operation statuses every 57 seconds
    var opid_interval =  57 * 1000;
    // shielding not required for some equihash coins
    if (requireShielding === true) {
        var checkOpids = function() {
            clearTimeout(opidTimeout);
            var checkOpIdSuccessAndGetResult = function(ops) {
                var batchRPC = [];
                // if there are no op-ids
                if (ops.length == 0) {
                    // and we think there is
                    if (opidCount !== 0) {
                        // clear them!
                        opidCount = 0;
                        opids = [];
                        logger.warning(logSystem, logComponent, 'Clearing operation ids due to empty result set.');
                    }
                }
                // loop through op-ids checking their status
                ops.forEach(function(op, i){
                    // check operation id status
                    if (op.status == "success" || op.status == "failed") {
                        // clear operation id result
                        var opid_index = opids.indexOf(op.id);
                        if (opid_index > -1) {
                            // clear operation id count
                            batchRPC.push(['z_getoperationresult', [[op.id]]]);
                            opidCount--;
                            opids.splice(opid_index, 1);
                        }
                        // log status to console
                        if (op.status == "failed") {
                            if (op.error) {
                              logger.error(logSystem, logComponent, "Shielding operation failed " + op.id + " " + op.error.code +", " + op.error.message);
                            } else {
                              logger.error(logSystem, logComponent, "Shielding operation failed " + op.id);
                            }
                        } else {
                            logger.special(logSystem, logComponent, 'Shielding operation success ' + op.id + '  txid: ' + op.result.txid);
                        }
                    } else if (op.status == "executing") {
                        logger.special(logSystem, logComponent, 'Shielding operation in progress ' + op.id );
                    }
                });
                /* Clear stuck operations*/
                logger.special(logSystem, logComponent, "Running z_operationresult to clear finished operations");
                batchRPC.push(['z_getoperationresult']);
                // if there are no completed operations
                if (batchRPC.length <= 0) {
                    opidTimeout = setTimeout(checkOpids, opid_interval);
                    return;
                }
                // clear results for completed operations
                daemon.batchCmd(batchRPC, function(error, results){
                    if (error || !results) {
                        opidTimeout = setTimeout(checkOpids, opid_interval);
                        logger.error(logSystem, logComponent, 'Error with RPC call z_getoperationresult ' + JSON.stringify(error));
                        return;
                    }
                    // check result execution_secs vs pool_config
                    results.forEach(function(result, i) {
                        if (result.result[i] && parseFloat(result.result[i].execution_secs || 0) > shielding_interval) {
                            logger.warning(logSystem, logComponent, 'Warning, walletInverval shorter than opid execution time of '+result.result[i].execution_secs+' secs.');
                        }
                    });
                    // keep checking operation ids
                    opidTimeout = setTimeout(checkOpids, opid_interval);
                });
            };
            // check for completed operation ids
            daemon.cmd('z_getoperationstatus', null, function (result) {
                var err = false;
                if (result.error) {
                    err = true;
                    logger.error(logSystem, logComponent, 'Error with RPC call z_getoperationstatus ' + JSON.stringify(result.error));
                } else if (result.response) {
                    checkOpIdSuccessAndGetResult(result.response);
                } else {
                    err = true;
                    logger.error(logSystem, logComponent, 'No response from z_getoperationstatus RPC call.');
                }
                if (err === true) {
                    opidTimeout = setTimeout(checkOpids, opid_interval);
                    if (opidCount !== 0) {
                        opidCount = 0;
                        opids = [];
                        logger.warning(logSystem, logComponent, 'Clearing operation ids due to RPC call errors.');
                    }
                }
            }, true, true);
        }
        var opidTimeout = setTimeout(checkOpids, opid_interval);
    }

    function roundTo(n, digits) {
        if (digits === undefined) {
            digits = 0;
        }
        var multiplicator = Math.pow(10, digits);
        n = parseFloat((n * multiplicator).toFixed(11));
        var test =(Math.round(n) / multiplicator);
        return +(test.toFixed(digits));
    }

    var satoshisToCoins = function(satoshis){
        return roundTo((satoshis / magnitude), coinPrecision);
    };

    var coinsToSatoshies = function(coins){
        return Math.round(coins * magnitude);
    };

    function coinsRound(number) {
        return roundTo(number, coinPrecision);
    }

    function checkForDuplicateBlockHeight(rounds, height) {
        var count = 0;
        for (var i = 0; i < rounds.length; i++) {
            if (rounds[i].height == height)
                count++;
        }
        return count > 1;
    }

    /* Deal with numbers in smallest possible units (satoshis) as much as possible. This greatly helps with accuracy
       when rounding and whatnot. When we are storing numbers for only humans to see, store in whole coin units. */

    var processPayments = function(){
        if (useZallet && paymentRunning) return;
        if (useZallet) paymentRunning = true;

        var startPaymentProcess = Date.now();
        var availableFunds;

        var timeSpentRPC = 0;
        var timeSpentRedis = 0;

        var startTimeRedis;
        var startTimeRPC;

        var startRedisTimer = function(){ startTimeRedis = Date.now() };
        var endRedisTimer = function(){ timeSpentRedis += Date.now() - startTimeRedis };

        var startRPCTimer = function(){ startTimeRPC = Date.now(); };
        var endRPCTimer = function(){ timeSpentRPC += Date.now() - startTimeRedis };

        async.waterfall([
            function(callback) {
                if (!useZallet) return callback();
                redisClient.get(pendingPaymentKey, function(error, pending) {
                    if (error || pending)
                        return stopZalletPayments(error || new Error('Unreconciled payment already exists'), callback);
                    callback();
                });
            },
            /*
                Step 1 - build workers and rounds objects from redis
                         * removes duplicate block submissions from redis
            */
            function(callback){
                startRedisTimer();
                redisClient.multi([
                    ['hgetall', coin + ':balances'],
                    ['smembers', coin + ':blocksPending']
                ]).exec(function(error, results){
                    endRedisTimer();
                    if (error){
                        logger.error(logSystem, logComponent, 'Could not get blocks from redis ' + JSON.stringify(error));
                        callback(true);
                        return;
                    }
                    // build workers object from :balances
                    var workers = {};
                    for (var w in results[0]){
                        workers[w] = {balance: coinsToSatoshies(parseFloat(results[0][w]))};
                    }
                    // build rounds object from :blocksPending
                    var rounds = results[1].map(function(r){
                        var details = r.split(':');
                        return {
                            blockHash: details[0],
                            txHash: details[1],
                            height: details[2],
                            minedby: details[3],
                            time: details[4],
                            duplicate: false,
                            serialized: r
                        };
                    });
                    /* sort rounds by block height to pay in order */
                    rounds.sort(function(a, b) {
                        return a.height - b.height;
                    });
                    // find duplicate blocks by height
                    // this can happen when two or more solutions are submitted at the same block height
                    var duplicateFound = false;
                    for (var i = 0; i < rounds.length; i++) {
                        if (checkForDuplicateBlockHeight(rounds, rounds[i].height) === true) {
                            rounds[i].duplicate = true;
                            duplicateFound = true;
                        }
                    }
                    // handle duplicates if needed
                    if (duplicateFound) {
                        var dups = rounds.filter(function(round){ return round.duplicate; });
                        logger.warning(logSystem, logComponent, 'Duplicate pending blocks found: ' + JSON.stringify(dups));
                        // attempt to find the invalid duplicates
                        var rpcDupCheck = dups.map(function(r){
                            return ['getblock', [r.blockHash]];
                        });
                        startRPCTimer();
                        miningDaemon.batchCmd(rpcDupCheck, function(error, blocks){
                            endRPCTimer();
                            if (error || !blocks) {
                                logger.error(logSystem, logComponent, 'Error with duplicate block check rpc call getblock ' + JSON.stringify(error));
                                return callback(true);
                            }
                            // look for the invalid duplicate block
                            var validBlocks = {}; // hashtable for unique look up
                            var invalidBlocks = []; // array for redis work
                            blocks.forEach(function(block, i) {
                                if (block && block.result) {
                                    // invalid duplicate submit blocks have negative confirmations
                                    if (block.result.confirmations < 0) {
                                        logger.warning(logSystem, logComponent, 'Remove invalid duplicate block ' + block.result.height + ' > ' + block.result.hash);
                                        // move from blocksPending to blocksDuplicate...
                                        invalidBlocks.push(['smove', coin + ':blocksPending', coin + ':blocksDuplicate', dups[i].serialized]);
                                    } else {
                                        // block must be valid, make sure it is unique
                                        if (validBlocks.hasOwnProperty(dups[i].blockHash)) {
                                            // not unique duplicate block
                                            logger.warning(logSystem, logComponent, 'Remove non-unique duplicate block ' + block.result.height + ' > ' + block.result.hash);
                                            // move from blocksPending to blocksDuplicate...
                                            invalidBlocks.push(['smove', coin + ':blocksPending', coin + ':blocksDuplicate', dups[i].serialized]);
                                        } else {
                                            // keep unique valid block
                                            validBlocks[dups[i].blockHash] = dups[i].serialized;
                                            logger.debug(logSystem, logComponent, 'Keep valid duplicate block ' + block.result.height + ' > ' + block.result.hash);
                                        }
                                    }
                                }
                            });
                            // filter out all duplicates to prevent double payments
                            rounds = rounds.filter(function(round){ return !round.duplicate; });
                            // if we detected the invalid duplicates, move them
                            if (invalidBlocks.length > 0) {
                                // move invalid duplicate blocks in redis
                                startRedisTimer();
                                redisClient.multi(invalidBlocks).exec(function(error, kicked){
                                    endRedisTimer();
                                    if (error) {
                                        logger.error(logSystem, logComponent, 'Error could not move invalid duplicate blocks in redis ' + JSON.stringify(error));
                                    }
                                    // continue payments normally
                                    callback(null, workers, rounds);
                                });
                            } else {
                                // notify pool owner that we are unable to find the invalid duplicate blocks, manual intervention required...
                                logger.error(logSystem, logComponent, 'Unable to detect invalid duplicate blocks, duplicate block payments on hold.');
                                // continue payments normally
                                callback(null, workers, rounds);
                            }
                        });
                    } else {
                        // no duplicates, continue payments normally
                        callback(null, workers, rounds);
                    }
                });
            },


            /*
                Step 2 - check if mined block coinbase tx are ready for payment
                         * adds block reward to rounds object
                         * adds block confirmations count to rounds object
            */
            function(workers, rounds, callback){
                // get pending block tx details
                var batchRPCcommand = rounds.map(function(r){
                    return ['gettransaction', [r.txHash]];
                });
                // get account address (not implemented at this time)
                batchRPCcommand.push(['getaccount', [poolOptions.address]]);

                startRPCTimer();
                var getTransactions = useZallet ? zalletTransactions : function(rounds, next) {
                    daemon.batchCmd(batchRPCcommand, next);
                };
                getTransactions(rounds, function(error, txDetails){
                    endRPCTimer();
                    if (error || !txDetails){
                        logger.error(logSystem, logComponent, 'Check finished - daemon rpc error with batch gettransactions ' +
                            (error && error.message ? error.message : JSON.stringify(error)));
                        callback(true);
                        return;
                    }

                    var addressAccount = "";

                    // check for transaction errors and generated coins
                    txDetails.forEach(function(tx, i){
                        if (i === txDetails.length - 1){
                            if (tx.result && tx.result.toString().length > 0) {
                                addressAccount = tx.result.toString();
                            }
                            return;
                        }
                        var round = rounds[i];
                        // update confirmations for round
                        if (tx && tx.result)
                            round.confirmations = parseInt((tx.result.confirmations || 0));

                        // look for transaction errors
                        // NOTE: We should combine these two if blocks into one since the only difference is in the logged message.
                        if (tx.error && tx.error.code === -5){
                            if (undefined == badBlocks[round.txHash]) {
                                badBlocks[round.txHash] = 0
                            }

                            if (badBlocks[round.txHash] >= 15) {
                                logger.warning(logSystem, logComponent, 'ERROR: Daemon reports invalid transaction: ' + round.txHash)
                                delete badBlocks[round.txHash]
                                round.category = 'kicked'
                            } else {
                                badBlocks[round.txHash]++
                                logger.warning(logSystem, logComponent, `Abandoned block ${round.txHash} check ${badBlocks[round.txHash]}/15`)
                            }

                            return;
                        } else if (!tx.result.details || (tx.result.details && tx.result.details.length === 0)) {
                            if (undefined == badBlocks[round.txHash]) {
                                badBlocks[round.txHash] = 0
                            }

                            if (badBlocks[round.txHash] >= 15) {
                                logger.warning(logSystem, logComponent, 'ERROR: Daemon reports no details for transaction: ' + round.txHash)
                                delete badBlocks[round.txHash]
                                round.category = 'kicked'
                            } else {
                                badBlocks[round.txHash]++
                                logger.warning(logSystem, logComponent, `Abandoned block ${round.txHash} check ${badBlocks[round.txHash]}/15`)
                            }

                            return;
                        } else if (tx.error || !tx.result) {
                            return logger.error(logSystem, logComponent, `ERROR: Odd error with gettransaction ${round.txHash} ${JSON.stringify(tx)}`)
                        }

                        // get the coin base generation tx
                        const generationTx = tx.result.details.filter(tx => tx.address === poolOptions.address)[0]

                        if (!generationTx && tx.result.details.length === 1) {
                            generationTx = tx.result.details[0]
                        }

                        if (!generationTx){
                            return logger.error(logSystem, logComponent, `ERROR: Missing output details to pool address for transaction ${round.txHash}`)
                        }

                        // get transaction category for round
                        round.category = generationTx.category

                        if (!useZallet) {
                            // Preserve the legacy zcashd maturity override.
                            if (typeof poolOptions.coin.poolOptions.confirmations === 'undefined') {
                                poolOptions.coin.poolOptions.confirmations = 100;
                            }
                            if (round.confirmations >= poolOptions.coin.poolOptions.confirmations) {
                                round.category = 'generate';
                            } else if (round.confirmations <= poolOptions.coin.poolOptions.confirmations) {
                                round.category = 'immature';
                            }
                        }

                        // get reward for newly generated blocks
                        if (round.category === 'generate' || round.category === 'immature') {
                            round.reward = coinsRound(parseFloat(generationTx.amount || generationTx.value))
                        }

                        // Clear blocks that previously triggered an attempted kick.
                        if (!round.txHash in badBlocks) {
                            logger.error(logSystem, logComponent, `${round.txHash} is no longer bad!`)
                            delete badBlocks[round.txHash]
                        }
                    });

                    var canDeleteShares = function(r){
                        for (var i = 0; i < rounds.length; i++){
                            var compareR = rounds[i];
                            if ((compareR.height === r.height)
                                && (compareR.category !== 'kicked')
                                && (compareR.category !== 'orphan')
                                && (compareR.serialized !== r.serialized)){
                                return false;
                            }
                        }
                        return true;
                    };

                    // only pay max blocks at a time
                    var payingBlocks = 0;
                    rounds = rounds.filter(function(r){
                        switch (r.category) {
                            case 'orphan':
                            case 'kicked':
                                r.canDeleteShares = canDeleteShares(r);
                            case 'immature':
                                return true;
                            case 'generate':
                                payingBlocks++;
                                // if over maxBlocksPerPayment...
                                // change category to immature to prevent payment
                                // and to keep track of confirmations/immature balances
                                if (payingBlocks > maxBlocksPerPayment)
                                    r.category = 'immature';
                                return true;
                            default:
                                return false;
                        };
                    });

                    // continue to next step in waterfall
                    callback(null, workers, rounds, addressAccount);
                });
            },


            /*
                Step 3 - lookup shares and calculate rewards
                         * pull pplnt times from redis
                         * pull shares from redis
                         * calculate rewards
                         * pplnt share reductions if needed
            */
            function(workers, rounds, addressAccount, callback){
                // pplnt times lookup
                var timeLookups = rounds.map(function(r){
                    return ['hgetall', coin + ':shares:times' + r.height]
                });
                startRedisTimer();
                redisClient.multi(timeLookups).exec(function(error, allWorkerTimes){
                    endRedisTimer();
                    if (error){
                        callback('Check finished - redis error with multi get rounds time');
                        return;
                    }
                    // shares lookup
                    var shareLookups = rounds.map(function(r){
                        return ['hgetall', coin + ':shares:round' + r.height];
                    });
                    startRedisTimer();
                    redisClient.multi(shareLookups).exec(function(error, allWorkerShares){
                        endRedisTimer();
                        if (error){
                            callback('Check finished - redis error with multi get rounds share');
                            return;
                        }

                        // error detection
                        var err = null;
                        var performPayment = false;

                        var notAddr = null;
                        if (requireShielding === true) {
                            notAddr = poolOptions.address;
                        }

                        // calculate what the pool owes its miners
                        var feeSatoshi = coinsToSatoshies(fee);
                        var totalOwed = parseInt(0);
                        for (var i = 0; i < rounds.length; i++) {
                            // only pay generated blocks, not orphaned, kicked, immature
                            if (rounds[i].category == 'generate') {
                                totalOwed = totalOwed + coinsToSatoshies(rounds[i].reward) - feeSatoshi;
                            }
                        }
                        // also include balances owed
                        for (var w in workers) {
                            var worker = workers[w];
                            totalOwed = totalOwed + (worker.balance||0);
                        }
                        // check if we have enough tAddress funds to begin payment processing
                        listUnspent(null, notAddr, minConfPayout, false, function (error, tBalance){
                            if (error) {
                                logger.error(logSystem, logComponent, 'Error checking pool balance before processing payments.');
                                return callback(true);
                            } else if (tBalance < totalOwed) {
                                logger.error(logSystem, logComponent,  'Insufficient funds ('+satoshisToCoins(tBalance) + ') to process payments (' + satoshisToCoins(totalOwed)+'); possibly waiting for txs.');
                                performPayment = false;
                            } else if (tBalance > totalOwed) {
                                performPayment = true;
                            }
                            if (useZallet) availableFunds = tBalance;
                            // just in case...
                            if (totalOwed <= 0) {
                                performPayment = false;
                            }
                            // if we can not perform payment
                            if (performPayment === false) {
                                // convert category generate to immature
                                rounds = rounds.filter(function(r){
                                    switch (r.category) {
                                        case 'orphan':
                                        case 'kicked':
                                        case 'immature':
                                           return true;
                                       case 'generate':
                                           r.category = 'immature';
                                           return true;
                                        default:
                                            return false;
                                    };
                                });
                            }

                            // handle rounds
                            rounds.forEach(function(round, i){
                                var workerShares = allWorkerShares[i];
                                if (!workerShares){
                                    err = true;
                                    logger.error(logSystem, logComponent, 'No worker shares for round: ' + round.height + ' blockHash: ' + round.blockHash);
                                    return;
                                }
                                var workerTimesWithPoolIds = allWorkerTimes[i];
                                var workerTimes = {};
                                var maxTime = 0;
                                if (pplntEnabled === true) {
	                                for (var workerAddressWithPoolId in workerTimesWithPoolIds){
                                        var workerWithoutPoolId = workerAddressWithPoolId.split('.')[0];
                                        var workerTimeFloat = parseFloat(workerTimesWithPoolIds[workerAddressWithPoolId]);
                                        if (maxTime < workerTimeFloat) {
                                            maxTime = workerTimeFloat;
                                        }
	                                    if (!(workerWithoutPoolId in workerTimes)) {
	                                        workerTimes[workerWithoutPoolId] = workerTimeFloat;
	                                    } else {
                                            // add time from other instances with penalty
	                                        if (workerTimes[workerWithoutPoolId] < workerTimeFloat) {
	                                            workerTimes[workerWithoutPoolId] = workerTimes[workerWithoutPoolId] * 0.5 + workerTimeFloat;
	                                        } else {
                                                workerTimes[workerWithoutPoolId] = workerTimes[workerWithoutPoolId] + workerTimeFloat * 0.5;
                                            }
                                            if (workerTimes[workerWithoutPoolId] > maxTime) {
                                                workerTimes[workerWithoutPoolId] = maxTime;
                                            }
	                                    }
	                                }
                                }
                                switch (round.category){
                                    case 'kicked':
                                    case 'orphan':
                                        round.workerShares = workerShares;
                                        break;

                                    /* calculate immature balances */
                                    case 'immature':
                                        var feeSatoshi = coinsToSatoshies(fee);
                                        var immature = coinsToSatoshies(round.reward);
                                        var totalShares = parseFloat(0);
                                        var sharesLost = parseFloat(0);

                                        // adjust block immature .. tx fees
                                        immature = Math.round(immature - feeSatoshi);

                                        // total up shares for round
                                        for (var workerAddress in workerShares){
                                            var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                            var shares = parseFloat((workerShares[workerAddress] || 0));
                                            // if pplnt mode
                                            if (pplntEnabled === true && maxTime > 0) {
                                                var tshares = shares;
                                                var lost = parseFloat(0);
                                                var address = workerAddress.split('.')[0];
                                                if (workerTimes[address] != null && parseFloat(workerTimes[address]) > 0) {
                                                    var timePeriod = roundTo(parseFloat(workerTimes[address] || 1) / maxTime , 2);
                                                    if (timePeriod > 0 && timePeriod < pplntTimeQualify) {
                                                        var lost = shares - (shares * timePeriod);
                                                        sharesLost += lost;
                                                        shares = Math.max(shares - lost, 0);
                                                    }
                                                }
                                            }
                                            worker.roundShares = shares;
                                            totalShares += shares;
                                        }

                                        //console.log('--IMMATURE DEBUG--------------');
                                        //console.log('performPayment: '+performPayment);
                                        //console.log('blockHeight: '+round.height);
                                        //console.log('blockReward: '+Math.round(immature));
                                        //console.log('blockConfirmations: '+round.confirmations);

                                        // calculate rewards for round
                                        var totalAmount = 0;
                                        for (var workerAddress in workerShares){
                                            var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                            var percent = parseFloat(worker.roundShares) / totalShares;
                                            // calculate workers immature for this round
                                            var workerImmatureTotal = Math.round(immature * percent);
                                            worker.immature = (worker.immature || 0) + workerImmatureTotal;
                                            totalAmount += workerImmatureTotal;
                                        }

                                        //console.log('----------------------------');
                                        break;

                                    /* calculate reward balances */
                                    case 'generate':
                                        var feeSatoshi = coinsToSatoshies(fee);
                                        var reward = coinsToSatoshies(round.reward);
                                        var totalShares = parseFloat(0);
                                        var sharesLost = parseFloat(0);

                                        // adjust block reward .. tx fees
                                        reward = Math.round(reward - feeSatoshi);

                                        // total up shares for round
                                        for (var workerAddress in workerShares){
                                            var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                            var shares = parseFloat((workerShares[workerAddress] || 0));
                                            // if pplnt mode
                                            if (pplntEnabled === true && maxTime > 0) {
                                                var tshares = shares;
                                                var lost = parseFloat(0);
                                                var address = workerAddress.split('.')[0];
                                                if (workerTimes[address] != null && parseFloat(workerTimes[address]) > 0) {
                                                    var timePeriod = roundTo(parseFloat(workerTimes[address] || 1) / maxTime , 2);
                                                    if (timePeriod > 0 && timePeriod < pplntTimeQualify) {
                                                        var lost = shares - (shares * timePeriod);
                                                        sharesLost += lost;
                                                        shares = Math.max(shares - lost, 0);
                                                        logger.warning(logSystem, logComponent, 'PPLNT: Reduced shares for '+workerAddress+' round:' + round.height + ' maxTime:'+maxTime+'sec timePeriod:'+roundTo(timePeriod,6)+' shares:'+tshares+' lost:'+lost+' new:'+shares);
                                                    }
                                                    if (timePeriod > 1.0) {
                                                        err = true;
                                                        logger.error(logSystem, logComponent, 'Time share period is greater than 1.0 for '+workerAddress+' round:' + round.height + ' blockHash:' + round.blockHash);
                                                        return;
                                                    }
                                                    worker.timePeriod = timePeriod;
                                                }
                                            }
                                            worker.roundShares = shares;
                                            worker.totalShares = parseFloat(worker.totalShares || 0) + shares;
                                            totalShares += shares;
                                        }

                                        //console.log('--REWARD DEBUG--------------');
                                        //console.log('performPayment: '+performPayment);
                                        //console.log('blockHeight: '+round.height);
                                        //console.log('blockReward: ' + Math.round(reward));
                                        //console.log('blockConfirmations: '+round.confirmations);

                                        // calculate rewards for round
                                        var totalAmount = 0;
                                        for (var workerAddress in workerShares){
                                            var worker = workers[workerAddress] = (workers[workerAddress] || {});
                                            var percent = parseFloat(worker.roundShares) / totalShares;
                                            if (percent > 1.0) {
                                                err = true;
                                                logger.error(logSystem, logComponent, 'Share percent is greater than 1.0 for '+workerAddress+' round:' + round.height + ' blockHash:' + round.blockHash);
                                                return;
                                            }
                                            // calculate workers reward for this round
                                            var workerRewardTotal = Math.round(reward * percent);
                                            worker.reward = (worker.reward || 0) + workerRewardTotal;
                                            totalAmount += workerRewardTotal;
                                        }

                                        //console.log('----------------------------');
                                        break;
                                }
                            });

                            // if there was no errors
                            if (err === null) {
                                callback(null, workers, rounds, addressAccount);
                            } else {
                                // some error, stop waterfall
                                callback(true);
                            }

                        }); // end funds check
                    });// end share lookup
                }); // end time lookup

            },


            /*
               Step 4 - Generate RPC commands to send payments
               When deciding the sent balance, it the difference should be -1*amount they had in db,
               If not sending the balance, the differnce should be +(the amount they earned this round)
            */
            function(workers, rounds, addressAccount, callback) {

                var tries = 0;
                var trySend = function (withholdPercent) {

                    var addressAmounts = {};
                    var balanceAmounts = {};
                    var shareAmounts = {};
                    var timePeriods = {};
                    var minerTotals = {};
                    var totalSent = 0;
                    var totalShares = 0;

                    // track attempts made, calls to trySend...
                    tries++;

                    // total up miner's balances
                    for (var w in workers) {
                        var worker = workers[w];
                        totalShares += (worker.totalShares || 0)
                        worker.balance = worker.balance || 0;
                        worker.reward = worker.reward || 0;
                        // get miner payout totals
                        var toSendSatoshis = Math.round((worker.balance + worker.reward) * (1 - withholdPercent));
                        var address = worker.address = (worker.address || getProperAddress(w.split('.')[0])).trim();
                        if (minerTotals[address] != null && minerTotals[address] > 0) {
                            minerTotals[address] += toSendSatoshis;
                        } else {
                            minerTotals[address] = toSendSatoshis;
                        }
                    }
                    // now process each workers balance, and pay the miner
                    for (var w in workers) {
                        var worker = workers[w];
                        worker.balance = worker.balance || 0;
                        worker.reward = worker.reward || 0;
                        var toSendSatoshis = Math.round((worker.balance + worker.reward) * (1 - withholdPercent));
                        var address = worker.address = (worker.address || getProperAddress(w.split('.')[0])).trim();
                        // if miners total is enough, go ahead and add this worker balance
                        if (minerTotals[address] >= minPaymentSatoshis) {
                            totalSent += toSendSatoshis;
                            // send funds
                            worker.sent = satoshisToCoins(toSendSatoshis);
                            worker.balanceChange = Math.min(worker.balance, toSendSatoshis) * -1;
                            if (addressAmounts[address] != null && addressAmounts[address] > 0) {
                                addressAmounts[address] = coinsRound(addressAmounts[address] + worker.sent);
                            } else {
                                addressAmounts[address] = worker.sent;
                            }
                        } else {
                            // add to balance, not enough minerals
                            worker.sent = 0;
                            worker.balanceChange = Math.max(toSendSatoshis - worker.balance, 0);
                            // track balance changes
                            if (worker.balanceChange > 0) {
                                if (balanceAmounts[address] != null && balanceAmounts[address] > 0) {
                                    balanceAmounts[address] = coinsRound(balanceAmounts[address] + satoshisToCoins(worker.balanceChange));
                                } else {
                                    balanceAmounts[address] = satoshisToCoins(worker.balanceChange);
                                }
                            }
                        }
                        // track share work
                        if (worker.totalShares > 0) {
                            if (shareAmounts[address] != null && shareAmounts[address] > 0) {
                                shareAmounts[address] += worker.totalShares;
                            } else {
                                shareAmounts[address] = worker.totalShares;
                            }
                        }
                    }

                    // if no payouts...continue to next set of callbacks
                    if (Object.keys(addressAmounts).length === 0){
                        callback(null, workers, rounds, []);
                        return;
                    }

                    // do final rounding of payments per address
                    // this forces amounts to be valid (0.12345678)
                    for (var a in addressAmounts) {
                        addressAmounts[a] = coinsRound(addressAmounts[a]);
                    }
                    if (useZallet && totalSent + coinsToSatoshies(fee) > availableFunds) {
                        logger.warning(logSystem, logComponent, 'Waiting for pool-account funds including the fee reserve.');
                        return callback(true);
                    }

                    // POINT OF NO RETURN! GOOD LUCK!
                    // WE ARE SENDING PAYMENT CMD TO DAEMON

                    // perform the sendmany operation .. addressAccount
                    var rpccallTracking = 'sendmany "" '+JSON.stringify(addressAmounts);
                    //console.log(rpccallTracking);

                    var sendPayment = useZallet ? function(done) {
                        sendZallet(addressAmounts, workers, rounds, function(error, result) {
                            done(error ? {error: {message: error.message}} : result);
                        });
                    } : function(done) {
                        daemon.cmd('sendmany', ["", addressAmounts], done, true, true);
                    };
                    sendPayment(function (result) {
                        // check for failed payments, there are many reasons
                        if (result.error && result.error.code === -6) {
                            // check if it is because we don't have enough funds
                            if (result.error.message && result.error.message.includes("insufficient funds")) {
                                // only try up to XX times (Max, 0.5%)
                                if (tries < 5) {
                                    // we thought we had enough funds to send payments, but apparently not...
                                    // try decreasing payments by a small percent to cover unexpected tx fees?
                                    var higherPercent = withholdPercent + 0.001; // 0.1%
                                    logger.warning(logSystem, logComponent, 'Insufficient funds (??) for payments ('+satoshisToCoins(totalSent)+'), decreasing rewards by ' + (higherPercent * 100).toFixed(1) + '% and retrying');
                                    trySend(higherPercent);
                                } else {
                                    logger.warning(logSystem, logComponent, rpccallTracking);
                                    logger.error(logSystem, logComponent, "Error sending payments, decreased rewards by too much!!!");
                                    callback(true);
                                }
                            } else {
                                // there was some fatal payment error?
                                logger.warning(logSystem, logComponent, rpccallTracking);
                                logger.error(logSystem, logComponent, 'Error sending payments ' + JSON.stringify(result.error));
                                // payment failed, prevent updates to redis
                                callback(true);
                            }
                            return;
                        }
                        else if (result.error && result.error.code === -5) {
                            // invalid address specified in addressAmounts array
                            logger.warning(logSystem, logComponent, rpccallTracking);
                            logger.error(logSystem, logComponent, 'Error sending payments ' + JSON.stringify(result.error));
                            // payment failed, prevent updates to redis
                            callback(true);
                            return;
                        }
                        else if (result.error && result.error.message != null) {
                            // invalid amount, others?
                            logger.warning(logSystem, logComponent, rpccallTracking);
                            logger.error(logSystem, logComponent, 'Error sending payments ' + JSON.stringify(result.error));
                            // payment failed, prevent updates to redis
                            callback(true);
                            return;
                        }
                        else if (result.error) {
                            // unknown error
                            logger.error(logSystem, logComponent, 'Error sending payments ' + JSON.stringify(result.error));
                            // payment failed, prevent updates to redis
                            callback(true);
                            return;
                        }
                        else {

                            // make sure sendmany gives us back a txid
                            var txid = null;
                            if (result.response) {
                                txid = result.response;
                            }
                            if (txid != null) {

                                // it worked, congrats on your pools payout ;)
                                logger.special(logSystem, logComponent, 'Sent ' + satoshisToCoins(totalSent)
                                    + ' to ' + Object.keys(addressAmounts).length + ' miners; txid: '+txid);

                                if (withholdPercent > 0) {
                                    logger.warning(logSystem, logComponent, 'Had to withhold ' + (withholdPercent * 100)
                                        + '% of reward from miners to cover transaction fees. '
                                        + 'Fund pool wallet with coins to prevent this from happening');
                                }

                                // save payments data to redis
                                var paymentBlocks = rounds.filter(function(r){ return r.category == 'generate'; }).map(function(r){
                                    return parseInt(r.height);
                                });

                                var paymentsUpdate = [];
                                var paymentsData = {time:Date.now(), txid:txid, shares:totalShares, paid:satoshisToCoins(totalSent),  miners:Object.keys(addressAmounts).length, blocks: paymentBlocks, amounts: addressAmounts, balances: balanceAmounts, work:shareAmounts};
                                if (useZallet) paymentsData.txids = result.txids;
                                paymentsUpdate.push(['zadd', logComponent + ':payments', Date.now(), JSON.stringify(paymentsData)]);

                                callback(null, workers, rounds, paymentsUpdate);

                            } else {

                                clearInterval(paymentInterval);

                                logger.error(logSystem, logComponent, 'Error RPC sendmany did not return txid '
                                    + JSON.stringify(result) + 'Disabling payment processing to prevent possible double-payouts.');

                                callback(true);
                                return;
                            }
                        }
                    });
                };

                // attempt to send any owed payments
                trySend(0);
            },


            /*
                Step 5 - Final redis commands
            */
            function(workers, rounds, paymentsUpdate, callback){

                var totalPaid = parseFloat(0);

                var immatureUpdateCommands = [];
                var balanceUpdateCommands = [];
                var workerPayoutsCommand = [];

                // update worker paid/balance stats
                for (var w in workers) {
                    var worker = workers[w];
                    // update balances
                    if ((worker.balanceChange || 0) !== 0){
                        balanceUpdateCommands.push([
                            'hincrbyfloat',
                            coin + ':balances',
                            w,
                            satoshisToCoins(worker.balanceChange)
                        ]);
                    }
                    // update payouts
                    if ((worker.sent || 0) > 0){
                        workerPayoutsCommand.push(['hincrbyfloat', coin + ':payouts', w, coinsRound(worker.sent)]);
                        totalPaid = coinsRound(totalPaid + worker.sent);
                    }
                    // update immature balances
                    if ((worker.immature || 0) > 0) {
                        immatureUpdateCommands.push(['hset', coin + ':immature', w, worker.immature]);
                    } else {
                        immatureUpdateCommands.push(['hset', coin + ':immature', w, 0]);
                    }
                }

                var movePendingCommands = [];
                var roundsToDelete = [];
                var orphanMergeCommands = [];

                var confirmsUpdate = [];
                var confirmsToDelete = [];

                var moveSharesToCurrent = function(r){
                    var workerShares = r.workerShares;
                    if (workerShares != null) {
                        logger.warning(logSystem, logComponent, 'Moving shares from orphaned block '+r.height+' to current round.');
                        Object.keys(workerShares).forEach(function(worker){
                            orphanMergeCommands.push(['hincrby', coin + ':shares:roundCurrent', worker, workerShares[worker]]);
                        });
                    }
                };

                rounds.forEach(function(r){
                    switch(r.category){
                        case 'kicked':
                        case 'orphan':
                            confirmsToDelete.push(['hdel', coin + ':blocksPendingConfirms', r.blockHash]);
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksKicked', r.serialized]);
                            if (r.canDeleteShares){
                                moveSharesToCurrent(r);
                                roundsToDelete.push(coin + ':shares:round' + r.height);
                                roundsToDelete.push(coin + ':shares:times' + r.height);
                            }
                            return;
                        case 'immature':
                            confirmsUpdate.push(['hset', coin + ':blocksPendingConfirms', r.blockHash, (r.confirmations || 0)]);
                            return;
                        case 'generate':
                            confirmsToDelete.push(['hdel', coin + ':blocksPendingConfirms', r.blockHash]);
                            movePendingCommands.push(['smove', coin + ':blocksPending', coin + ':blocksConfirmed', r.serialized]);
                            roundsToDelete.push(coin + ':shares:round' + r.height);
                            roundsToDelete.push(coin + ':shares:times' + r.height);
                            return;
                    }
                });

                var finalRedisCommands = [];

                if (movePendingCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(movePendingCommands);

                if (orphanMergeCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);

                if (immatureUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(immatureUpdateCommands);

                if (balanceUpdateCommands.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);

                if (workerPayoutsCommand.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);

                if (roundsToDelete.length > 0)
                    finalRedisCommands.push(['del'].concat(roundsToDelete));

                if (confirmsUpdate.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(confirmsUpdate);

                if (confirmsToDelete.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(confirmsToDelete);

                if (paymentsUpdate.length > 0)
                    finalRedisCommands = finalRedisCommands.concat(paymentsUpdate);

                if (totalPaid !== 0)
                    finalRedisCommands.push(['hincrbyfloat', coin + ':stats', 'totalPaid', totalPaid]);

                if (finalRedisCommands.length === 0){
                    callback();
                    return;
                }

                function commitAccounting() {
                    startRedisTimer();
                    redisClient.multi(finalRedisCommands).exec(function(error, results){
                        endRedisTimer();
                        if (useZallet && !error && (!results || results.some(function(result) { return result instanceof Error; })))
                            error = new Error('Redis accounting command failed; inspect the pending payment journal');
                        if (useZallet && error) return stopZalletPayments(error, callback);
                        if (error) {
                            clearInterval(paymentInterval);

                            logger.error(logSystem, logComponent,
                                    'Payments sent but could not update redis. ' + JSON.stringify(error)
                                    + ' Disabling payment processing to prevent possible double-payouts. The redis commands in '
                                    + coin + '_finalRedisCommands.txt must be ran manually');

                            fs.writeFile(coin + '_finalRedisCommands.txt', JSON.stringify(finalRedisCommands), function(err){
                                logger.error('Could not write finalRedisCommands.txt, you are fucked.');
                            });
                        }
                        if (useZallet && pendingPayment && !error) {
                            // Keep the fence through EXEC, including lost replies and per-command errors.
                            return redisClient.del(pendingPaymentKey, function(error) {
                                if (error) return stopZalletPayments(error, callback);
                                pendingPayment = null;
                                callback();
                            });
                        }
                        callback(error);
                    });
                }
                if (useZallet && pendingPayment) {
                    pendingPayment.finalRedisCommands = finalRedisCommands;
                    savePendingPayment(function(error) {
                        if (error) return stopZalletPayments(error, callback);
                        commitAccounting();
                    });
                } else {
                    commitAccounting();
                }
            }

        ], function(error){
            if (useZallet) paymentRunning = false;
            if (useZallet && !error)
                logger.debug(logSystem, logComponent, 'Zallet payment cycle completed');

            var paymentProcessTime = Date.now() - startPaymentProcess;
            logger.debug(logSystem, logComponent, 'Finished interval - time spent: '
                + paymentProcessTime + 'ms total, ' + timeSpentRedis + 'ms redis, '
                + timeSpentRPC + 'ms daemon RPC');

        });
    };


    var getProperAddress = function(address){
        // Zallet validates complete transparent/Sapling/Unified addresses; never redirect a payout.
        if (useZallet) return address;
        if (address.length >= 40){
            logger.warning(logSystem, logComponent, 'Invalid address '+address+', convert to address '+(poolOptions.invalidAddress || poolOptions.address));
            return (poolOptions.invalidAddress || poolOptions.address);
        }
        if (address.length <= 30) {
            logger.warning(logSystem, logComponent, 'Invalid address '+address+', convert to address '+(poolOptions.invalidAddress || poolOptions.address));
            return (poolOptions.invalidAddress || poolOptions.address);
        }
        return address;
    };

}
