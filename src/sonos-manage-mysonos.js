/**
 * All functions provided by My Sonos node. My Sonos node handles Music-Library and My-Sonos.
 * My Sonos also holds SONOS-Playlist.
 *
 * @module MySonos
 * 
 * @author Henning Klages
*/
'use strict'

const {
  PACKAGE_PREFIX, REGEX_ANYCHAR, REGEX_ANYCHAR_BLANK, REGEX_IP, REGEX_DNS,
  REGEX_SERIAL, ML_REQUESTS_MAXIMUM, TIMEOUT_DISCOVERY, TIMEOUT_HTTP_REQUEST
} = require('./Globals.js')

const { discoverSpecificSonosPlayerBySerial } = require('./Discovery.js')

const { getMusicLibraryItemsV2, getMySonos
} = require('./Commands.js')

const { failure, decideCreateNodeOn, success, replaceAposColon
} = require('./Extensions.js')

const { isTruthy, isTruthyProperty, isTruthyPropertyStringNotEmpty, validRegex, validToInteger
} = require('./Helper.js')

const { SonosDevice } = require('@svrooij/sonos/lib')

const Dns = require('dns')
const dnsPromises = Dns.promises

const debug = require('debug')(`${PACKAGE_PREFIX}mysonos`)

module.exports = function (RED) {

  // function lexical order, ascending
  const COMMAND_TABLE_MYSONOS = {
    'library.export.album': libraryExportItem,
    'library.export.artist': libraryExportItem,
    'library.export.playlist': libraryExportItem,
    'library.export.track': libraryExportItem,
    'library.get.albums': libraryGetItem,
    'library.get.artists': libraryGetItem,
    'library.get.playlists': libraryGetItem,
    'library.get.tracks': libraryGetItem,
    'mysonos.export.item': mysonosExportItem,
    'mysonos.get.items': mysonosGetItems,
    'mysonos.queue.item': mysonosQueueItem,
    'mysonos.stream.item': mysonosStreamItem
  }

  /**  Create My Sonos node, get valid ip address, store nodeDialog and subscribe to messages.
   * @param {object} config current node configuration data
   */
  function SonosManageMySonosNode (config) {
    debug('command:%s', 'SonosManageMySonosNode')
    const thisFunctionName = 'create and subscribe'
    RED.nodes.createNode(this, config)
    const node = this
    node.status({}) // Clear node status

    const configNode = RED.nodes.getNode(config.confignode)

    // Order of processing of the two fields ip/dns field versus serial number field:
    // 1. ipv4 address entered and syntax is valid
    // 2. DNS name entered and syntax is valid: resolve and use resolved ipv4 address
    // 3. No ipv4/DNS entered & serial entered & valid syntax: 
    //    discover ipv4 address by serial and use it   
    if (isTruthyPropertyStringNotEmpty(configNode, ['ipaddress'])) {

      const hostname = configNode.ipaddress // ipv4 address or dns name, syntax not validated
      let ipv4Address // pure ipv4Address, syntax validated
      
      // async wrap to make it possible to use await dnsPromise
      (async function () { 
        if (REGEX_IP.test(hostname)) {
          ipv4Address = hostname // priority 1
        } else if (REGEX_DNS.test(hostname)) {
          const ipv4Array = await dnsPromises.resolve4(hostname) 
          // dnsPromise returns an array with all data
          ipv4Address = ipv4Array[0] // priority 2
        } else {
          failure(node, null,
            new Error(`${PACKAGE_PREFIX} ipv4//DNS name >>${hostname} invalid syntax`),
            thisFunctionName)
          return
        }
        // ipv4Address is a pure ipv4 address and ready to use
        const port = 1400 // assuming this port
        const playerUrlObject = new URL(`http://${ipv4Address}:${port}`)
        // If box is ticked it is checked whether that IP address is reachable (http request)
        decideCreateNodeOn(playerUrlObject, TIMEOUT_HTTP_REQUEST,
          config.avoidCheckPlayerAvailability)
          .then((createNodeOn) => {
            if (createNodeOn) {
              // subscribe and set processing function
              node.on('input', (msg) => {
                debug('msg received >>%s', 'universal node')
                processInputMsg(node, config, msg, playerUrlObject.hostname)
                  // processInputMsg sets msg.nrcspCmd to current command
                  .then((msgUpdate) => {
                    Object.assign(msg, msgUpdate) // Defines the output message
                    success(node, msg, msg.nrcspCmd)
                  })
                  .catch((error) => {
                    let lastFunction = 'processInputMsg'
                    if (msg.nrcspCmd && typeof msg.nrcspCmd === 'string') {
                      lastFunction = msg.nrcspCmd
                    }
                    failure(node, msg, error, lastFunction)
                  })
              })
              debug('successfully subscribed - node.on')
              node.status({ fill: 'green', shape: 'dot', text: 'ok:ready' })
            } else {
              debug('device not reachable/rejected')
              node.status({
                fill: 'red', shape: 'dot',
                text: 'error: device not reachable/rejected'
              })
            }
          }) // then createnode
          .catch((err) => {
            debug('xIsSonos failed >>%s', JSON.stringify(err, Object.getOwnPropertyNames(err)))
            node.status({ fill: 'red', shape: 'dot', text: 'error: decideCreateNodeOn went wrong' })
          }) // catch
      })() // async function
        .catch((err) => {
          debug('Could not retrieve ipv4 >>%', JSON.stringify(err, Object.getOwnPropertyNames(err)))
          failure(node, null,
            new Error(`${PACKAGE_PREFIX} Could not retrieve ipv4 for >>${hostname}`),
            thisFunctionName)
        })
      
    } else if (isTruthyPropertyStringNotEmpty(configNode, ['serialnum'])) {
      // start discovery
      const serialNb = configNode.serialnum
      if (!REGEX_SERIAL.test(serialNb)) {
        failure(node, null,
          new Error(`${PACKAGE_PREFIX} serial number >>${serialNb} invalid syntax`),
          thisFunctionName)
        return
      }
      discoverSpecificSonosPlayerBySerial(configNode.serialnum, TIMEOUT_DISCOVERY)
        .then((discoveredHost) => {
          debug('found ip address >>%s', discoveredHost)
          const validHost = discoveredHost
          
          // subscribe and set processing function
          node.on('input', (msg) => {
            debug('msg received >>%s', 'universal node')
            processInputMsg(node, config, msg, validHost)
            // processInputMsg sets msg.nrcspCmd to current command
              .then((msgUpdate) => {
                Object.assign(msg, msgUpdate) // Defines the output message
                success(node, msg, msg.nrcspCmd)
              })
              .catch((error) => {
                let lastFunction = 'processInputMsg'
                if (msg.nrcspCmd && typeof msg.nrcspCmd === 'string') {
                  lastFunction = msg.nrcspCmd
                }
                failure(node, msg, error, lastFunction)
              })
          })
          debug('successfully subscribed - node.on')
          node.status({ fill: 'green', shape: 'dot', text: 'ok:ready' })

        })
        .catch((err) => {
          // discovery failed - most likely because could not find any matching player
          debug('discovery failed >>%s', JSON.stringify(err, Object.getOwnPropertyNames(err)))
          failure(node, null, 'could not discover player by serial', thisFunctionName)
          return
        })
   
    } else {
      failure(node, null,
        new Error(`${PACKAGE_PREFIX} both ip address/serial number are invalid`), thisFunctionName)
      return
    }
  }

  /** Validate sonos player object, command and dispatch further.
   * @param {object} node current node
   * @param {object} config current node configuration
   * @param {string} config.command the command from node dialog
   * @param {string} config.state the state from node dialog
   * @param {object} msg incoming message
   * @param {string} urlHost host of SONOS player such as 192.168.178.37
   *
   * Creates also msg.nrcspCmd with the used command in lower case.
   * Modifies msg.payload if set in dialog or for output!
   *
   * @returns {promise} All commands have to return a promise - object
   * example: returning {} means msg is not modified (except msg.nrcspCmd)
   * example: returning { 'payload': true } means 
   * the original msg.payload will be modified and set to true.
   */
  async function processInputMsg (node, config, msg, urlHost) {
    debug('command:%s', 'processInputMsg')
    const tsPlayer = new SonosDevice(urlHost)
    if (!isTruthy(tsPlayer)) {
      throw new Error(`${PACKAGE_PREFIX} tsPlayer is undefined`)
    }
    if (!(isTruthyPropertyStringNotEmpty(tsPlayer, ['host'])
      && isTruthyProperty(tsPlayer, ['port']))) {
      throw new Error(`${PACKAGE_PREFIX} tsPlayer ip address or port is missing `)
    }
    // needed for my extension in Extensions
    tsPlayer.urlObject = new URL(`http://${tsPlayer.host}:${tsPlayer.port}`)

    // Command, required: node dialog overrules msg, store lowercase version in nrcspCmd
    let command
    if (config.command !== 'message') { // command specified in node dialog
      command = config.command
    } else {
      if (!isTruthyPropertyStringNotEmpty(msg, ['topic'])) {
        throw new Error(`${PACKAGE_PREFIX} command is undefined/invalid`)
      }
      command = String(msg.topic).toLowerCase()

      // you may omit mysonos. prefix - so we add it here
      const REGEX_PREFIX = /^(mysonos|library)/
      if (!REGEX_PREFIX.test(command)) {
        command = `mysonos.${command}`
      }
    }
    if (!Object.prototype.hasOwnProperty.call(COMMAND_TABLE_MYSONOS, command)) {
      throw new Error(`${PACKAGE_PREFIX} command is invalid >>${command} `)
    }
    msg.nrcspCmd = command // Store command, used in exportLibrary*

    // state: node dialog overrules msg.
    let state
    if (config.state) { // payload specified in node dialog
      state = RED.util.evaluateNodeProperty(config.state, config.stateType, node)
      if (typeof state === 'string') {
        if (state !== '') {
          msg.payload = state
        }
      } else if (typeof state === 'number') {
        if (state !== '') {
          msg.payload = state
        }
      } else if (typeof state === 'boolean') {
        msg.payload = state
      }
    }
    
    return COMMAND_TABLE_MYSONOS[command](msg, tsPlayer)
  }

  //
  //                                          COMMANDS
  //

  /**
   * @typedef {object} exportedItem exported data which can be used in group.play.export
   * @global
   * @property {string} uri the URI to be used in SetAVTransport or AddURIToQeueu
   * @property {string} metadata metadata for the uri
   * @property {boolean} queue true means use AddURI otherwise SetAVTransport
   */

  /**  Exports  first matching playlist, album, artist, track from Music Library 
   * @param {object} msg incoming message
   * @param {string} msg.payload search string, part of item title
   * @param {string} msg.nrcspCmd identify the item type
   * @param {object} tsPlayer node-sonos player with urlObject - as default
   *
   * @returns {promise<exportedItem>}
   * 
   * @throws {error} 'no matching item found'
   * @throws {error} all methods
   */
  async function libraryExportItem (msg, tsPlayer) {
    debug('command:%s', 'libraryExportItem')

    // payload title search string is required.
    const validSearch = validRegex(msg, 'payload', REGEX_ANYCHAR, 'search string')

    let type = ''
    if (msg.nrcspCmd === 'library.export.playlist') {
      type = 'A:PLAYLISTS:'
    } else if (msg.nrcspCmd === 'library.export.album') {
      type = 'A:ALBUM:'
    } else if (msg.nrcspCmd === 'library.export.artist') {
      type = 'A:ARTIST:'
    } else if (msg.nrcspCmd === 'library.export.track') {
      type = 'A:TRACKS:'
    } else {
      // Can not happen
    }
    
    const list = await getMusicLibraryItemsV2(type, validSearch, ML_REQUESTS_MAXIMUM, tsPlayer)
    // select the first item returned
    if (list.length === 0) {
      throw new Error(`${PACKAGE_PREFIX} no matching item found`)
    }
    // 2021-08-03 there might be an apos; in uri - to be replaced!
    const firstItem = {
      'uri': replaceAposColon(list[0].uri), 
      'metadata': list[0].metadata
    }

    return { 'payload': { 'uri': firstItem.uri, 'metadata': firstItem.metadata, 'queue': true } }
  }

  /**  Outputs Music-Library item (album, artist, playlist, tarck) as array - 
   * search string is optional
   * @param {object} msg incoming message
   * @param {string} [msg.payload] search string, part of title
   * @param {string} msg.nrcspCmd identify the item type
   * @param {object} tsPlayer node-sonos player with urlObject - as default
   *
   * @returns {promise} {payload: array of objects: uri metadata queue title artist} 
   * array may be empty
   *
   * @throws {error} all methods
   */
  async function libraryGetItem (msg, tsPlayer) {
    debug('command:%s', 'libraryGetItem')
    
    // payload as title search string is optional.
    // eslint-disable-next-line max-len
    const validSearch = validRegex(msg, 'payload', REGEX_ANYCHAR_BLANK, 'payload search in title', '')
    
    let type = ''
    if (msg.nrcspCmd === 'library.get.playlists') {
      type = 'A:PLAYLISTS:'
    } else if (msg.nrcspCmd === 'library.get.albums') {
      type = 'A:ALBUM:'
    } else if (msg.nrcspCmd === 'library.get.artists') {
      type = 'A:ARTIST:'
    } else if (msg.nrcspCmd === 'library.get.tracks') {
      type = 'A:TRACKS:'
    } else {
      // Can not happen
    }
     
    // ML_REQUESTS_MAXIMUM limits the overall number of items
    const list = await getMusicLibraryItemsV2(type, validSearch, ML_REQUESTS_MAXIMUM, tsPlayer)
    
    // add ip address to albumUri, processingType, modify uri (apos;)
    const payload = list.map(element => {
      if (typeof element.artUri === 'string' && element.artUri.startsWith('/getaa')) {
        element.artUri = tsPlayer.urlObject.origin + element.artUri
      }  
      element.processingType = 'queue'
      element.uri = replaceAposColon(element.uri)
      return element
    })

    return { payload }
  }
  
  /**  Export first My-Sonos item matching search string.
   * @param {object} msg incoming message
   * @param {string} msg.payload search string
   * @param {object} tsPlayer sonos-ts player with .urlObject as Javascript build-in URL
   *
   * @returns {promise<exportedItem>} 
   *
   * @throws 'could not find any My Sonos items', 'no title matching search string'
   * @throws {error} all methods
   *
   * Info: content validation of mediaType, serviceName
   */
  async function mysonosExportItem (msg, tsPlayer) {
    debug('command:%s', 'mysonosExportItem')
    // payload title search string is required.
    const validSearch
      = validRegex(msg, 'payload', REGEX_ANYCHAR, 'search string')

    const mySonosItems = await getMySonos(tsPlayer)
    if (!isTruthy(mySonosItems)) {
      throw new Error(`${PACKAGE_PREFIX} could not find any My Sonos items`)
    }
    
    // find in title property (findIndex returns -1 if not found)
    const foundIndex = mySonosItems.findIndex((item) => {
      return (item.title.includes(validSearch))
    })
    if (foundIndex === -1) {
      throw new Error(`${PACKAGE_PREFIX} no title matching search string >>${validSearch}`)
    }

    return { 'payload': {
      'uri': mySonosItems[foundIndex].uri,
      'metadata': mySonosItems[foundIndex].metadata,
      'queue': (mySonosItems[foundIndex].processingType === 'queue')
    } }

  }

  /**  Outputs array of My-Sonos items as object.
   * @param {object} msg incoming message
   * @param {object} tsPlayer sonos-ts player with .urlObject as Javascript build-in URL
   *
   * @returns {promise<mySonosItem[]>}
   *
   * @throws 'could not find any My Sonos items'
   * @throws {error} all methods
   */
  async function mysonosGetItems (msg, tsPlayer) {
    debug('command:%s', 'mysonosGetItems')
    const payload = await getMySonos(tsPlayer)
    if (!isTruthy(payload)) {
      throw new Error(`${PACKAGE_PREFIX} could not find any My Sonos items`)
    }

    return { payload }
  }

  /**  Queues (aka add) first My-Sonos item matching search string.
   * @param {object} msg incoming message
   * @param {string} msg.payload search string
   * @param {object} tsPlayer sonos-ts player with .urlObject as Javascript build-in URL
   *
   * @returns {promise} {}
   *
   * @throws 'could not find any My Sonos items', 'no title matching search string'
   * @throws {error} all methods
   * 
   */
  async function mysonosQueueItem (msg, tsPlayer) {
    debug('command:%s', 'mysonosQueueItem')
    // payload title search string is required.
    const validSearch
      = validRegex(msg, 'payload', REGEX_ANYCHAR, 'search string')

    const mySonosItems = await getMySonos(tsPlayer)
    if (!isTruthy(mySonosItems)) {
      throw new Error(`${PACKAGE_PREFIX} could not find any My Sonos items`)
    }
    // find in title, findIndex returns -1 if not found
    const foundIndex = mySonosItems.findIndex((item) => {
      return (item.title.includes(validSearch) && (item.processingType === 'queue'))
    })
    if (foundIndex === -1) {
      throw new Error(`${PACKAGE_PREFIX} no title matching search string >>${validSearch}`)
    }
    
    await tsPlayer.AVTransportService.AddURIToQueue(
      { 'InstanceID': 0, 
        'EnqueuedURI': mySonosItems[foundIndex].uri,
        'EnqueuedURIMetaData': mySonosItems[foundIndex].metadata,
        'DesiredFirstTrackNumberEnqueued': 0,
        'EnqueueAsNext': true
      })

    return {}
  }

  /** Stream (aka play) first My-Sonos item matching search string.
   * @param {object} msg incoming message
   * @param {string} msg.payload search string
   * @param {string} msg.volume new volume 0 ..100
   * @param {object} tsPlayer sonos-ts player with .urlObject as Javascript build-in URL
   *
   * @returns {promise} {}
   *
   * @throws 'could not find any My Sonos items', 'no title matching search string'
   * @throws {error} all methods
   */
  async function mysonosStreamItem (msg, tsPlayer) {
    debug('command:%s', 'mysonosStreamItem')
    // payload title search string is required.
    const validSearch
      = validRegex(msg, 'payload', REGEX_ANYCHAR, 'search string')

    const mySonosItems = await getMySonos(tsPlayer)
    if (!isTruthy(mySonosItems)) {
      throw new Error(`${PACKAGE_PREFIX} could not find any My Sonos items`)
    }
    // find in title, findIndex returns -1 if not found
    const foundIndex = mySonosItems.findIndex((item) => {
      return (item.title.includes(validSearch) && (item.processingType === 'stream'))
    })
    if (foundIndex === -1) {
      throw new Error(`${PACKAGE_PREFIX} no title matching search string >>${validSearch}`)
    }
    
    await tsPlayer.SetAVTransportURI(mySonosItems[foundIndex].uri)

    // change volume if is provided
    const newVolume = validToInteger(msg, 'volume', 0, 100, 'volume', -1)
    if (newVolume !== -1) {
      await tsPlayer.SetVolume(newVolume)
    }
    tsPlayer.Play()
    
    return {}
  }

  RED.nodes.registerType('sonos-manage-mysonos', SonosManageMySonosNode)
}
