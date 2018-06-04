var Protocol = require('@brook/pomelo-protocol')
var Package = Protocol.Package
var Message = Protocol.Message
var EventEmitter = require('wolfy87-eventemitter')
var protobuf = require('pomelo-protobuf')
var JS_WS_CLIENT_TYPE = 'js-websocket'
var JS_WS_CLIENT_VERSION = '0.0.1'

var heartbeatIntervalConst = 3000
var nextHeartbeatTimeoutConst = 0
var gapThresholdConst = 100 // heartbeat gap threshold
var RES_OK = 200
var RES_OLD_CLIENT = 501
var CLOSE_CODE = {
  heartbeatTimeout: 1001
}

var Pomelo = function () {
  this.closeCode = 0
  this.socket = null
  this.reqId = 0
  this.callbacks = {}
  this.handlers = {}
  this.routeMap = {}
  this.heartbeatInterval = heartbeatIntervalConst
  this.heartbeatTimeout = heartbeatIntervalConst * 2
  this.nextHeartbeatTimeout = nextHeartbeatTimeoutConst
  this.gapThreshold = gapThresholdConst // heartbeat gap threshold
  this.heartbeatId = null
  this.heartbeatTimeoutId = null
  this.handshakeCallback = null
  initPomleo(this)
  this.handshakeBuffer = {
    'sys': {
      type: JS_WS_CLIENT_TYPE,
      version: JS_WS_CLIENT_VERSION
    },
    'user': {}
  }
}

Pomelo.prototype = Object.create(EventEmitter.prototype)
Pomelo.prototype.init = function (params, cb) {
  var port = params.port
  if (!params.url) {
    params.url = 'ws://' + params.host + (port ? (':' + port) : '')
  }
  this.params = params
  // params.debug = true
  this.initCallback = cb

  if (!params.type) {
    this.handshakeBuffer.user = params.user
    this.handshakeCallback = params.handshakeCallback
    this.initWebSocket()
  }
}

Pomelo.prototype.onData = function (self, data) {
  // probuff decode
  var msg = Message.decode(data)

  if (msg.id > 0) {
    msg.route = self.routeMap[msg.id]
    delete self.routeMap[msg.id]
    if (!msg.route) {
      return
    }
  }
  msg.body = deCompose(self, msg)
  processMessage(self, msg)
}

var processMessage = function (pomelo, msg) {
  if (!msg || !msg.id) {
    // server push message
    // console.error('processMessage error!!!');
    pomelo.emit(msg.route, msg.body)
    return
  }

  // if have a id then find the callback function with the request
  var cb = pomelo.callbacks[msg.id]

  delete pomelo.callbacks[msg.id]
  if (typeof cb !== 'function') {
    return
  }

  cb(msg.body)
}

var deCompose = function (pomelo, msg) {
  var protos = pomelo.data.protos ? pomelo.data.protos.server : {}
  var abbrs = pomelo.data.abbrs
  var route = msg.route

  try {
    // Decompose route from dict
    if (msg.compressRoute) {
      if (!abbrs[route]) {
        return {}
      }

      route = msg.route = abbrs[route]
    }
    if (protos[route]) {
      return protobuf.decode(route, msg.body)
    } else {
      return JSON.parse(Protocol.strdecode(msg.body))
    }
  } catch (ex) {
    console.error(ex.stack)
  }

  return msg
}

Pomelo.prototype.onKick = function (sefl, data) {
  this.emit('onKick')
}

Pomelo.prototype.handshake = function (self, data) {
  data = JSON.parse(Protocol.strdecode(data))
  if (data.code === RES_OLD_CLIENT) {
    self.emit('error', 'client version not fullfill')
    return
  }

  if (data.code !== RES_OK) {
    self.emit('error', 'handshake fail')
    return
  }
  // self.handshakeInit(data);
  if (data.sys && data.sys.heartbeat) {
    self.heartbeatInterval = data.sys.heartbeat * 1000 // heartbeat interval
    self.heartbeatTimeout = self.heartbeatInterval * 2 // max heartbeat timeout
  } else {
    self.heartbeatInterval = 0
    self.heartbeatTimeout = 0
  }

  // self.initData(data);

  if (!data || !data.sys) {
    return
  }
  self.data = self.data || {}
  var dict = data.sys.dict
  var protos = data.sys.protos

  // Init compress dict
  if (dict) {
    self.data.dict = dict
    self.data.abbrs = {}

    for (var route in dict) {
      self.data.abbrs[dict[route]] = route
    }
  }

  // Init protobuf protos
  if (protos) {
    self.data.protos = {
      server: protos.server || {},
      client: protos.client || {}
    }
    if (protobuf) {
      protobuf.init({ encoderProtos: protos.client, decoderProtos: protos.server })
    }
  }
  //
  if (typeof self.handshakeCallback === 'function') {
    self.handshakeCallback(data.user)
  }

  //

  var obj = Package.encode(Package.TYPE_HANDSHAKE_ACK)
  send(self, obj)

  if (self.initCallback) {
    self.initCallback(self, self.socket)
    self.reconnectAttempts = 0
    self.initializing = false
    self.emit('initialized')
    // self.initCallback = null
  }
}

Pomelo.prototype.processPackage = function (msg) {
  this.handlers[msg.type](this, msg.body)
}

Pomelo.prototype.initWebSocket = function () {
  if (this.initializing) {
    return
  }
  this.initializing = true
  var self = this
  var onopen = function (event) {
    var obj = Package.encode(Package.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(self.handshakeBuffer)))
    send(self, obj)
  }
  var onmessage = function (event) {
    self.processPackage(Package.decode(event.data))
      // new package arrived, update the heartbeat timeout
    if (self.heartbeatTimeout) {
      self.nextHeartbeatTimeout = Date.now() + self.heartbeatTimeout
    }
  }
  var onerror = function (event) {
    self.emit('io-error', event)
  }
  var onclose = function (event) {
    self.emit('close', event)
    self.initializing = false

    self.reconnect()
  }
  this.socket = new WebSocket(this.params.url)
  this.socket.binaryType = 'arraybuffer'
  this.socket.onopen = onopen
  this.socket.onmessage = onmessage
  this.socket.onerror = onerror
  this.socket.onclose = onclose
}

Pomelo.prototype.reconnect = function () {
  if (!this.initializing &&
    this.params.reconnect &&
    (!this.socket || this.socket.readyState !== 1) &&
    this.closeCode >= 0) {
    if (this.reconnectAttempts < this.params.maxReconnectAttempts) {
      var reconnectionDelay = this.reconnectAttempts * 2
      this.emit('disconnected', { delay: reconnectionDelay, attempt: this.reconnectAttempts })
      var self = this
      setTimeout(function () {
        if (self.closeCode >= 0) { // closeCode not changed
          self.emit('reconnecting', { attempt: this.reconnectAttempts })
          self.initWebSocket()
        }
      }, reconnectionDelay * 1000)
      this.reconnectAttempts++
    } else {
      this.emit('disconnected', false)
    }
  }
}
Pomelo.prototype.getdebug = function () {
  return [this.initializing, this.params.reconnect, this.socket ? this.socket.readyState : -1, this.closeCode, this.reconnectAttempts, this.params.maxReconnectAttempts].join('|')
}

Pomelo.prototype.request = function (route, msg, cb) {
  msg = msg || {}
  route = route || msg.route
  if (!route) {
    return
  }

  this.reqId++
  sendMessage(this, this.reqId, route, msg)

  this.callbacks[this.reqId] = cb
  this.routeMap[this.reqId] = route
}

Pomelo.prototype.notify = function (route, msg) {
  msg = msg || {}
  sendMessage(this, 0, route, msg)
}

var sendMessage = function (self, reqId, route, msg) {
  var type = reqId ? Message.TYPE_REQUEST : Message.TYPE_NOTIFY

  // compress message by protobuf
  var protos = self.data.protos ? self.data.protos.client : {}
  if (protos[route]) {
    msg = protobuf.encode(route, msg)
  } else {
    msg = Protocol.strencode(JSON.stringify(msg))
  }

  var compressRoute = 0
  if (self.dict && self.dict[route]) {
    route = self.dict[route]
    compressRoute = 1
  }

  msg = Message.encode(reqId, type, compressRoute, route, msg)
  var packet = Package.encode(Package.TYPE_DATA, msg)
  send(self, packet)
}

Pomelo.prototype.disconnect = function (code) {
  this.closeCode = code || -1
  if (this.socket) {
    if (this.socket.disconnect) this.socket.disconnect()
    if (this.socket.close) this.socket.close()
    this.socket = null
  }
  if (this.heartbeatId) {
    clearTimeout(this.heartbeatId)
    this.heartbeatId = null
  }
  if (this.heartbeatTimeoutId) {
    clearTimeout(this.heartbeatTimeoutId)
    this.heartbeatTimeoutId = null
  }
}

Pomelo.prototype.heartbeat = function (self, data) {
  var obj = Package.encode(Package.TYPE_HEARTBEAT)
  if (self.heartbeatTimeoutId) {
    clearTimeout(self.heartbeatTimeoutId)
    self.heartbeatTimeoutId = null
  }

  if (self.heartbeatId) {
    // already in a heartbeat interval
    return
  }

  self.heartbeatId = setTimeout(function () {
    self.heartbeatId = null
    send(self, obj)

    self.nextHeartbeatTimeout = Date.now() + self.heartbeatTimeout
    self.heartbeatTimeoutId = setTimeout(self.heartbeatTimeoutCb.bind(self), self.heartbeatTimeout)
  }, self.heartbeatInterval)
}

Pomelo.prototype.heartbeatTimeoutCb = function () {
  var self = this
  var gap = self.nextHeartbeatTimeout - Date.now()
  if (gap > self.gapThreshold) {
    self.heartbeatTimeoutId = setTimeout(self.heartbeatTimeoutCb.bind(this), gap)
  } else {
    // console.warn('hb timeout')
    self.emit('heartbeat timeout')
    self.disconnect(CLOSE_CODE.heartbeatTimeout)
  }
}

var send = function (self, packet) {
  if (self.socket) {
    self.socket.send(packet.buffer || packet)
  } else if (self.closeCode >= 0) {
    // console.warn('No socket, reconnecting...')
    // self.once('initialized', function () {
    //   send(self, packet)
    // })
    // self.reconnect()
  }
}

var initPomleo = function (self) {
  self.handlers[Package.TYPE_HANDSHAKE] = self.handshake
  self.handlers[Package.TYPE_HEARTBEAT] = self.heartbeat
  self.handlers[Package.TYPE_DATA] = self.onData
  self.handlers[Package.TYPE_KICK] = self.onKick
}

module.exports = Pomelo
