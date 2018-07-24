/*
    SPDX-License-Identifier: Apache-2.0
*/

var Fabric_Client = require('fabric-client');
var helper = require("../../helper.js");
var logger = helper.getLogger("FabricClient");
var fs = require("fs-extra");
const BlockDecoder = require('fabric-client/lib/BlockDecoder');
var Admin = require("./Admin.js");
var grpc = require('grpc');
const User = require('fabric-client/lib/User.js');
const client_utils = require('fabric-client/lib/client-utils.js');
var FabricUtils = require('./FabricUtils.js');
const _commonProto = grpc.load(__dirname + '/../../../node_modules/fabric-client/lib/protos/common/common.proto').common;

class FabricClient {

    constructor(client_name) {
        this.client_name = client_name;
        this.hfc_client = new Fabric_Client();
        this.defaultPeer = {};
        this.defaultChannel = {};
        this.defaultOrderer = null;
        this.channelsGenHash = new Map();
        this.client_config;
        this.adminpeers = new Map();
        this.adminusers = new Map();
    }

    async initialize(client_config) {

        this.client_config = client_config;

        //Loading client from network configuration file
        logger.debug("Loading client  [%s] from configuration ...", this.client_name);
        await this.LoadClientFromConfig(client_config);
        logger.debug("Successfully loaded client [%s] from configuration", this.client_name);

        // getting channels from queryChannels
        let channels = await this.hfc_client.queryChannels(this.defaultPeer.getName(), true);
        logger.debug("Client channels >> %j", channels.channels);

        // initialize channel network information from Discover
        for (let channel of channels.channels) {
            await this.initializeNewChannel(channel.channel_id);
            logger.debug("Initialized channel >> %s", channel.channel_id);
        }

        try {
            // load default channel network details from discovery
            let result = await this.defaultChannel.getDiscoveryResults();
        }
        catch (e) {
            logger.debug('Channel Discovery >>  %s', e);
            throw new Error('Default defined channel ' + this.defaultChannel.getName() + ' not found for the client ' + this.client_name + ' peer');
        }
        // setting default orderer
        let channel_name = client_config.client.channel;
        let channel = await this.hfc_client.getChannel(channel_name);
        let temp_orderers = await channel.getOrderers();
        if (temp_orderers && temp_orderers.length > 0) {
            this.defaultOrderer = temp_orderers[0];
        }
        else {
            throw new Error('There are no orderers defined on this channel in the network configuration');
        }
        logger.debug("Set client [%s] default orderer as  >> %s", this.client_name, this.defaultOrderer.getName());
    }

    async LoadClientFromConfig(client_config) {

        var _self = this;
        //load client through hfc client network configuration class
        await this.hfc_client.loadFromConfig(client_config);
        // initialize credential stores
        await this.hfc_client.initCredentialStores();
        logger.debug("Successfully initialized credential stores for client [%s]", this.client_name);

        // Creating Admin User
        let organization = await this.hfc_client._network_config.getOrganization(client_config.client.organization, true);
        if (organization) {
            let mspid = organization.getMspid();
            let admin_key = organization.getAdminPrivateKey();
            let admin_cert = organization.getAdminCert();
            let username = this.client_name + "_" + mspid + "Admin";
            let user = await this.hfc_client.createUser({
                username: username,
                mspid: mspid,
                cryptoContent: {
                    privateKeyPEM: admin_key,
                    signedCertPEM: admin_cert
                },
                skipPersistence: false
            });
            logger.debug("Successfully created admin user [%s] for client [%s]", username, this.client_name);
            this.adminusers.set(username, user);
        }

        // Loading default Peer and channel
        let channel_name = client_config.client.channel;
        this.defaultChannel = this.hfc_client.getChannel(channel_name);
        logger.debug("Set client [%s] default channel as  >> %s", this.client_name, this.defaultChannel.getName());

        if (this.defaultChannel.getPeers().length > 0) {
            this.defaultPeer = this.defaultChannel.getPeers()[0];
        } else {
            throw new Error('Default peer is not added to the client ' + this.client_name);
        }
        logger.debug("Set client [%s] default peer as  >> %s", this.client_name, this.defaultPeer.getName());
        await this.initializeChannelFromDiscover(channel_name);
    }

    async initializeNewChannel(channel_name) {

        // If the new channel is not defined in configuration, then use default channel configuration as new channel configuration
        if (!this.client_config.channels[channel_name]) {
            this.hfc_client._network_config._network_config.channels[channel_name] = this.client_config.channels[this.defaultChannel.getName()];
        }
        // get channel, if the channel is not exist in the hfc client context,
        // then it will create new channel from the netwrok configuration
        let channel = this.hfc_client.getChannel(channel_name);
        await this.initializeChannelFromDiscover(channel_name);

        // get genesis block for the channel
        let block = await this.getGenesisBlock(channel);
        logger.debug("Genesis Block for client [%s] >> %j", this.client_name, block);
        let channel_genesis_hash = await FabricUtils.generateBlockHash(block.header);
        // setting channel_genesis_hash to map
        this.setChannelGenHash(channel_name, channel_genesis_hash);

        logger.debug("Channel genesis hash for channel [%s] >> %s", channel_name, channel_genesis_hash);

    }

    async initializeChannelFromDiscover(channel_name) {

        let channel = this.hfc_client.getChannel(channel_name);
        const discover_request = {
            target: this.defaultPeer.getName(),
            config: true
        };
        let discover_results = await channel._discover(discover_request);
        logger.debug("Discover results for client [%s] >> %j", this.client_name, discover_results);
        // creating users for admin peers
        if (discover_results) {
            if (discover_results.msps) {
                for (let msp_name in discover_results.msps) {
                    const msp = discover_results.msps[msp_name];

                    if (!channel._msp_manager.getMSP(msp.id)) {
                        const config = {
                            rootCerts: msp.rootCerts,
                            intermediateCerts: msp.intermediateCerts,
                            admins: msp.admins,
                            cryptoSuite: channel._clientContext._crytoSuite,
                            id: msp.id,
                            orgs: msp.orgs,
                            tls_root_certs: msp.tls_root_certs,
                            tls_intermediate_certs: msp.tls_intermediate_certs
                        };
                        channel._msp_manager.addMSP(config);
                    }


                    let username = this.client_name + "_" + msp.id + "Admin";
                    if (!this.adminusers.get(username)) {
                        let organization = await this.hfc_client._network_config.getOrganization(msp_name, true);
                        if (organization) {
                            let mspid = organization.getMspid();
                            let admin_key = organization.getAdminPrivateKey();
                            let admin_cert = organization.getAdminCert();
                            if (!admin_cert) {
                                admin_cert = msp.admins;
                            }
                            let user = await this.createUser({
                                username: username,
                                mspid: mspid,
                                cryptoContent: {
                                    privateKeyPEM: admin_key,
                                    signedCertPEM: admin_cert
                                }
                            });
                            logger.debug("Successfully created user [%s] for client [%s]", username, this.client_name);
                            this.adminusers.set(username, user);
                        }
                    }
                }
            }
            // creating orderers
            if (discover_results.orderers) {
                for (let msp_id in discover_results.orderers) {
                    const endpoints = discover_results.orderers[msp_id].endpoints;
                    for (const endpoint of endpoints) {
                        let requesturl = endpoint.host + ":" + endpoint.port;
                        if (this.client_config.orderers && this.client_config.orderers[requesturl] && this.client_config.orderers[requesturl].url) {
                            requesturl = this.client_config.orderers[requesturl].url;
                            this.newOrderer(channel_name, requesturl, msp_id, endpoint.host, discover_results.msps);
                            logger.debug("Successfully created orderer [%s:%s] for client [%s]", endpoint.host, endpoint.port, this.client_name);
                        }
                    }
                }
            }
            // creating admin peers
            if (discover_results && discover_results.peers_by_org) {
                for (let org_name in discover_results.peers_by_org) {
                    let org = discover_results.peers_by_org[org_name];
                    for (var peer of org.peers) {
                        let requesturl = peer.endpoint;
                        requesturl = this.client_config.peers[requesturl].url;
                        if (!this.adminpeers.get(requesturl)) {
                            let host_port = peer.endpoint.split(':');
                            let pem = this.buildTlsRootCerts(discover_results.msps[org_name]);
                            let adminpeer = new Admin(requesturl, {
                                pem: pem,
                                "ssl-target-name-override": host_port[0]
                            });
                            logger.debug("Successfully created Admin peer [%s] for client [%s]", peer.endpoint, this.client_name);
                            this.adminpeers.set(requesturl, adminpeer);
                        }
                    }
                }
            }
            channel._discovery_results = discover_results;
            return discover_results;
        }
        return;
    }

    newOrderer(channel_name, url, msp_id, host, msps) {
        let channel = this.hfc_client.getChannel(channel_name);
        let newOrderer = null;
        channel._orderers.forEach((orderer) => {
            if (orderer.getUrl() === url) {
                logger.debug('Found existing orderer %s', url);
                newOrderer = orderer;
            }
        });
        if (!newOrderer) {
            if (msps[msp_id]) {
                logger.debug('Create a new orderer %s', url);
                newOrderer = this.hfc_client.newOrderer(url, channel._buildOptions(url, url, host, msps[msp_id]));
                channel.addOrderer(newOrderer, true);
            } else {
                throw new Error('No TLS cert information available');
            }
        }
        return newOrderer;
    }

    async getPeerStatus(peer) {
        let adminpeer = this.adminpeers.get(peer.requests);
        let status = {};
        if (adminpeer) {
            let channel = this.getDefaultChannel();
            let username = this.client_name + "_" + peer.mspid + "Admin";
            let user = this.adminusers.get(username);
            if (user) {
                const signer = user.getSigningIdentity(true);
                const txId = this.hfc_client.newTransactionID(true);
                // build the header for use with the seekInfo payload
                const seekInfoHeader = client_utils.buildChannelHeader(
                    _commonProto.HeaderType.PEER_ADMIN_OPERATION,
                    channel._name,
                    txId.getTransactionID(),
                    channel._initial_epoch,
                    null,
                    client_utils.buildCurrentTimestamp(),
                    channel._clientContext.getClientCertHash()
                );
                const seekHeader = client_utils.buildHeader(signer, seekInfoHeader, txId.getNonce());
                const seekPayload = new _commonProto.Payload();
                seekPayload.setHeader(seekHeader);
                const seekPayloadBytes = seekPayload.toBuffer();
                const sig = signer.sign(seekPayloadBytes);
                const signature = Buffer.from(sig);
                // building manually or will get protobuf errors on send
                const envelope = {
                    signature: signature,
                    payload: seekPayloadBytes
                };
                status = await adminpeer.GetStatus(envelope);

            }
        } else {
            logger.debug("Admin peer Not found for %s", peer.requests);
        }
        return status;
    }

    async getGenesisBlock(channel) {
        let defaultOrderer = this.getDefaultOrderer();
        let request = {
            orderer: defaultOrderer,
            txId: this.getHFC_Client().newTransactionID(true) //get an admin based transactionID
        };
        let genesisBlock = await channel.getGenesisBlock(request);
        let block = BlockDecoder.decodeBlock(genesisBlock);
        return block;
    }

    async createUser(opts) {
        logger.debug('opts = %j', opts);
        if (!opts) {
            throw new Error('Client.createUser missing required \'opts\' parameter.');
        }
        if (!opts.username || opts.username.length < 1) {
            throw new Error('Client.createUser parameter \'opts username\' is required.');
        }
        if (!opts.mspid || opts.mspid.length < 1) {
            throw new Error('Client.createUser parameter \'opts mspid\' is required.');
        }
        if (opts.cryptoContent) {
            if (!opts.cryptoContent.privateKey && !opts.cryptoContent.privateKeyPEM && !opts.cryptoContent.privateKeyObj) {
                throw new Error('Client.createUser one of \'opts cryptoContent privateKey, privateKeyPEM or privateKeyObj\' is required.');
            }
            if (!opts.cryptoContent.signedCert && !opts.cryptoContent.signedCertPEM) {
                throw new Error('Client.createUser either \'opts cryptoContent signedCert or signedCertPEM\' is required.');
            }
        } else {
            throw new Error('Client.createUser parameter \'opts cryptoContent\' is required.');
        }
        let importedKey;
        const user = new User(opts.username);
        let privateKeyPEM = opts.cryptoContent.privateKeyPEM;
        if (privateKeyPEM) {
            logger.debug('then privateKeyPEM data');
            importedKey = await this.hfc_client.getCryptoSuite().importKey(privateKeyPEM.toString(), { ephemeral: !this.hfc_client.getCryptoSuite()._cryptoKeyStore });
        }
        let signedCertPEM = opts.cryptoContent.signedCertPEM;
        logger.debug('then signedCertPEM data');
        user.setCryptoSuite(this.hfc_client.getCryptoSuite());
        await user.setEnrollment(importedKey, signedCertPEM.toString(), opts.mspid);
        logger.debug('then user');
        return user;
    }

    buildOptions(url, host, msp) {
        const caroots = this.buildTlsRootCerts(msp);
        const opts = {
            'pem': caroots,
            'ssl-target-name-override': host,
            'name': url
        };
        return opts;
    }

    async getOrganizations(channel_genesis_hash) {
        channel._msp_manager
        let client = this.platform.getClient();
    }



    buildTlsRootCerts(msp) {
        let caroots = '';
        if (msp.tls_root_certs) {
            caroots = caroots + msp.tls_root_certs;
        }
        if (msp.tls_intermediate_certs) {
            caroots = caroots + msp.tls_intermediate_certs;
        }
        return caroots;
    }

    getChannelNames() {
        return Array.from(this.channelsGenHash.keys());
    }

    getHFC_Client() {
        return this.hfc_client;
    }

    getChannels() {
        return this.hfc_client._channels; // return Map
    }

    getChannelGenHash(channel_name) {
        return this.channelsGenHash.get(channel_name);
    }

    setChannelGenHash(name, channel_genesis_hash) {
        this.channelsGenHash.set(name, channel_genesis_hash);
    }

    getDefaultPeer() {
        return this.defaultPeer;
    }

    getClientName() {
        return this.client_name;
    }

    getDefaultChannel() {
        return this.defaultChannel;
    }

    getDefaultOrderer() {
        return this.defaultOrderer;
    }

    setDefaultPeer(defaultPeer) {
        this.defaultPeer = defaultPeer;
    }

    getChannelByHash(channel_genesis_hash) {
        for (var [channel_name, hash_name] of this.channelsGenHash.entries()) {
            if (channel_genesis_hash === hash_name) {
                return this.hfc_client.getChannel(channel_name);
            }
        }
    }

    getChannel(channel_name) {

        return this.hfc_client.getChannel(channel_name);
    }

    setDefaultChannel(channel_name) {
        this.defaultChannel = this.hfc_client.getChannel(channel_name);
    }

    setDefaultChannelByHash(new_channel_genesis_hash) {

        for (var [channel_name, channel_genesis_hash] of this.channelsGenHash.entries()) {

            if (new_channel_genesis_hash === channel_genesis_hash) {
                this.defaultChannel = this.hfc_client.getChannel(channel_name);
                return channel_genesis_hash;
            }
        }
    }
    setDefaultOrderer(defaultOrderer) {
        this.defaultOrderer = defaultOrderer;
    }
}

module.exports = FabricClient;