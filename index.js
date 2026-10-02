'use strict';

const axios = require('axios');

const NestConnection = require('./lib/nest-connection');

let ThermostatAccessory, HomeAwayAccessory, TempSensorAccessory, ProtectAccessory, LockAccessory;

require('promise.prototype.finally').shim(Promise);

Promise.delay = function(time_ms) {
    return new Promise(resolve => setTimeout(resolve, time_ms));
};

Promise.prototype.asCallback = function(callback) {
    this.then(res => callback(null, res)).catch(err => callback(err));
};

Promise.prototype.return = function(val) {
    this.then(function() {
        return val;
    });
};

class NestPlatform {
    constructor(log, config, api) {
        // auth info
        this.config = config;
        this.log = log;
        this.api = api;
        this.accessoryLookup = {};
        this.cachedAccessories = [];
        this.claimedUUIDs = new Set();
        this.excludedUUIDs = new Set();

        api.on('didFinishLaunching', async () => {
            this.log('Fetching Nest devices.');

            const deviceTypes = [ThermostatAccessory, HomeAwayAccessory, TempSensorAccessory, ProtectAccessory, LockAccessory];
            const disableFlags = {
                'thermostat': 'Thermostat.Disable',
                'temp_sensor': 'TempSensor.Disable',
                'protect': 'Protect.Disable',
                'home_away_sensor': 'HomeAway.Disable',
                'lock': 'Lock.Disable'
            };

            // Returns the accessories for devices not yet mounted. Devices that are already mounted, or that the
            // user excluded in config, are skipped.
            const mountNewDevices = function(data) {
                const mounted = [];
                for (const DeviceType of deviceTypes) {
                    const devices = (data.devices && data.devices[DeviceType.deviceGroup]) || {};
                    for (const deviceId of Object.keys(devices)) {
                        const uuid = this.accessoryUUID(DeviceType, deviceId);
                        if (this.accessoryLookup[deviceId] || this.excludedUUIDs.has(uuid)) {
                            continue;
                        }
                        const device = devices[deviceId];
                        const structureId = device.structure_id;
                        if (this.optionSet(disableFlags[DeviceType.deviceType], device.serial_number, deviceId)) {
                            this.excludedUUIDs.add(uuid);
                            continue;
                        }
                        if (this.config.structureId && this.config.structureId !== structureId) {
                            this.log('Skipping device ' + deviceId + ' because it is not in the required structure. Has ' + structureId + ', looking for ' + this.config.structureId + '.');
                            this.excludedUUIDs.add(uuid);
                            continue;
                        }
                        const accessory = new DeviceType(this.conn, this.log, device, data.structures[structureId], this);
                        accessory.removeUnclaimedServices();
                        this.accessoryLookup[deviceId] = accessory;
                        mounted.push(accessory);
                    }
                }
                return mounted;
            }.bind(this);

            const publishMounted = function(mounted) {
                const isNew = el => !this.cachedAccessories.includes(el.accessory);
                const newAccessories = mounted.filter(isNew).map(el => el.accessory);
                const reusedAccessories = mounted.filter(el => !isNew(el)).map(el => el.accessory);
                if (newAccessories.length > 0) {
                    this.api.registerPlatformAccessories('homebridge-nest', 'Nest', newAccessories);
                }
                if (reusedAccessories.length > 0) {
                    this.api.updatePlatformAccessories(reusedAccessories);
                }
            }.bind(this);

            const updateAccessories = function(data, accList) {
                accList.map(function(acc) {
                    const device = data.devices[acc.deviceGroup][acc.deviceId];
                    if (device) {
                        const structureId = device.structure_id;
                        const structure = data.structures[structureId];
                        acc.updateData(device, structure);
                    }
                });
            };

            let startupComplete = false;
            const handleUpdates = function(data) {
                if (!startupComplete) {
                    return;
                }
                const mounted = mountNewDevices(data);
                if (mounted.length > 0) {
                    mounted.forEach(el => this.log('Nest device "' + el.name + '" is now available.'));
                    publishMounted(mounted);
                }
                updateAccessories(data, Object.values(this.accessoryLookup));
            }.bind(this);

            try {
                this.conn = await this.setupConnection(this.optionSet('Debug.Verbose'), this.optionSet('Nest.FieldTest.Enable'));
                this.conn.accessories = this.accessoryLookup;
                await this.conn.subscribe(handleUpdates);
                await this.conn.observe(handleUpdates);

                let initialState = this.conn.apiResponseToObjectTree(this.conn.currentState);
                publishMounted(mountNewDevices(initialState));
                startupComplete = true;

                const excludedAccessories = this.cachedAccessories.filter(accessory => this.excludedUUIDs.has(accessory.UUID));
                if (excludedAccessories.length > 0) {
                    this.api.unregisterPlatformAccessories('homebridge-nest', 'Nest', excludedAccessories);
                }

                // Kept rather than removed, so HomeKit keeps their rooms and automations. They come back when Nest reports them.
                const missingAccessories = this.unclaimedCachedAccessories().filter(accessory => !this.excludedUUIDs.has(accessory.UUID));
                missingAccessories.forEach(accessory => this.log.warn('Nest did not report "' + accessory.displayName + '" at startup. It will show as not responding until Nest reports it.'));
                this.markUnavailable(missingAccessories);

                let accessoriesMounted = Object.values(this.accessoryLookup).map(el => el.constructor.name);

                if (this.config.readyCallback) {
                    axios.post(this.config.readyCallback, {
                        thermostat_count: accessoriesMounted.filter(el => el == 'NestThermostatAccessory').length,
                        tempsensor_count: accessoriesMounted.filter(el => el == 'NestTempSensorAccessory').length,
                        protect_count: accessoriesMounted.filter(el => el == 'NestProtectAccessory').length,
                        lock_count: accessoriesMounted.filter(el => el == 'NestLockAccessory').length
                    }).catch(() => { });
                }
            } catch(err) {
                this.log.error(err);
                this.log.error('NOTE: Because we couldn\'t connect to the Nest service, your Nest devices in HomeKit will not be responsive.');
                this.markUnavailable(this.unclaimedCachedAccessories());
            }
        });
    }

    configureAccessory(accessory) {
        this.cachedAccessories.push(accessory);
    }

    accessoryUUID(DeviceType, deviceId) {
        return this.api.hap.uuid.generate('nest' + '.' + DeviceType.deviceType + '.' + deviceId);
    }

    claimCachedAccessory(uuid) {
        const accessory = this.cachedAccessories.find(el => el.UUID === uuid);
        if (accessory) {
            this.claimedUUIDs.add(uuid);
            this.clearUnavailable(accessory);
        }
        return accessory;
    }

    unclaimedCachedAccessories() {
        return this.cachedAccessories.filter(accessory => !this.claimedUUIDs.has(accessory.UUID));
    }

    markUnavailable(accessories) {
        accessories.forEach(accessory => {
            accessory.services.forEach(service => {
                service.characteristics.forEach(characteristic => {
                    characteristic.on('get', callback => callback('error'));
                    characteristic.on('set', (value, callback) => callback('error'));
                    characteristic.value;
                });
            });
        });
    }

    clearUnavailable(accessory) {
        accessory.services.forEach(service => {
            service.characteristics.forEach(characteristic => {
                characteristic.removeAllListeners('get');
                characteristic.removeAllListeners('set');
            });
        });
    }

    optionSet(key, serialNumber, deviceId) {
        return key && this.config.options && (this.config.options.includes(key) || (serialNumber && this.config.options.includes(key + '.' + serialNumber)) || (deviceId && this.config.options.includes(key + '.' + deviceId)));
    }

    async setupConnection(verbose, fieldTestMode) {
        if (!this.config.access_token && !this.config.googleAuth && !this.config.refreshToken && (!this.config.email || !this.config.password)) {
            throw('You did not specify your Nest account credentials {\'email\',\'password\'}, or an access_token, refreshToken, or googleAuth, in config.json');
        }

        if (this.config.googleAuth && this.config.refreshToken) {
            throw('You have specified both googleAuth and refreshToken in config.json. Please pick the one you want to use, and remove the other one');
        }

        if (this.config.googleAuth && (!this.config.googleAuth.issueToken || !this.config.googleAuth.cookies)) { // || !this.config.googleAuth.apiKey)) {
            throw('When using googleAuth, you must provide issueToken and cookies in config.json. Please see README.md for instructions');
        }

        const conn = new NestConnection(this.config, this.log, verbose, fieldTestMode);

        if (await conn.auth()) {
            return conn;
        } else {
            throw('Unable to authenticate with Google/Nest.');
        }
    }
}

module.exports = function(homebridge) {
    const exportedTypes = {
        Accessory: homebridge.platformAccessory,
        Service: homebridge.hap.Service,
        Characteristic: homebridge.hap.Characteristic,
        hap: homebridge.hap
    };

    require('./lib/nest-device-accessory')(exportedTypes);
    ThermostatAccessory = require('./lib/nest-thermostat-accessory')();
    HomeAwayAccessory = require('./lib/nest-homeaway-accessory')();
    TempSensorAccessory = require('./lib/nest-tempsensor-accessory')();
    ProtectAccessory = require('./lib/nest-protect-accessory')();
    LockAccessory = require('./lib/nest-lock-accessory')();

    homebridge.registerPlatform('homebridge-nest', 'Nest', NestPlatform);
};
