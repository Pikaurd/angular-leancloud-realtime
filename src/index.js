import EventEmitter from 'eventemitter2';

class Realtime {
  constructor($rootScope, realtime, $q) {
    this.$rootScope = $rootScope;
    this.realtime = realtime;
    this.$q = $q;
    this._connectPromise = null;
  }

  connect(options, callback) {
    this._connectPromise = this.$q((resolve) => {
      this.realtimeInstance = this.realtime(options, (data) => {
        if (typeof callback === 'function') {
          callback(data);
        }
        resolve(data);
      });
    });
    return this._connectPromise;
  }
  _waitForConnect() {
    if (!this._connectPromise) {
      throw new Error('LeancloudRealtimeService.connect() never called.');
    } else {
      return this._connectPromise;
    }
  }

  close() {
    // TODO: sdk close 不会移除心跳
    this._waitForConnect().then(() => this.realtimeInstance.close());
  }

  on(event, callback) {
    this.realtimeInstance.on(event, (data) => {
      if (typeof callback === 'function') {
        callback(data);
      }
      this.$rootScope.$digest();
    });
  }

  once(event, callback) {
    this.realtimeInstance.once(event, (data) => {
      if (typeof callback === 'function') {
        callback(data);
      }
      this.$rootScope.$digest();
    });
  }

  off(...args) {
    this.realtimeInstance.off(...args);
  }

  emit(...args) {
    this.realtimeInstance.emit(...args);
  }

  room(options, callback) {
    return this._waitForConnect().then(() => this.$q((resolve, reject) =>
      this.realtimeInstance.room(options, (originalConversation) => {
        if (!originalConversation) {
          reject(new Error('400: Conversation not exists on server.'));
        } else {
          new Conversation(originalConversation, this.$rootScope, this.$q).then((conversation) => {
            if (typeof callback === 'function') {
              callback(conversation);
            }
            resolve(conversation);
          });
        }
      })
    ));
  }

  conv(...args) {
    return this.room(...args);
  }

  assign(messageClass) {
    MessageParser.assign(messageClass);
  }
}

class Conversation extends EventEmitter {
  constructor(originalConversation, $rootScope, $q) {
    super();
    this.originalConversation = originalConversation;
    this.$rootScope = $rootScope;
    this.$q = $q;

    [
      'id',
      'name',
      'attr'
    ].forEach((prop) => this[prop] = originalConversation[prop]);

    this._bindEvents();

    // TODO: members 应该是由 SDK 来维护的
    // SDK 中的 Conversation 封装把 members 等初始化的时候就能拿到的 members 信息都丢掉了
    // 这里只能异步再取一次
    return this.$q((resolve) => {
      this._list().then((members) => {
        this.members = members;
        resolve(this);
      });
    });
  }

  _bindEvents() {
    this.originalConversation.receive((message) => {
      this.emit('message', MessageParser.parse(message));
      this.$rootScope.$digest();
    });
  }

  // members 变成属性由 service 来维护，用户不再需要 list 方法
  _list() {
    return this.$q((resolve) => {
      this.originalConversation.list((members) => {
        resolve(members);
      });
    });
  }
  log(options, callback) {
    if (callback === undefined) {
      [callback, options] = [options, {}];
    }
    return this.$q((resolve) => {
      this.originalConversation.log(options, (messages) => {
        messages = messages.map((message) => MessageParser.parse(message));
        if (typeof callback === 'function') {
          callback(messages);
        }
        resolve(messages);
      });
    });
  }
  join(callback = () => {}) {
    return this.$q((resolve) => {
      this.originalConversation.join(() => {
        callback();
        resolve();
      });
    });
  }
  send(message, callback = () => {}) {
    if (typeof message === 'string') {
      return this.send(new Message(message));
    }
    var options = {
      r: message.needReceipt,
      transient: message.transient
    };
    return this.$q((resolve) => {
      this.originalConversation.send(message.toString(), options, () => {
        callback(message);
        resolve(message);
      });
    });
  }
  destroy() {
    // TODO: implement SDK 中的 Conversation::off 方法
  }
}

class Message {
  constructor(messageContent, mataData = {}) {
    {
      if (typeof content === 'string') {
        this.content = messageContent;
      }
      if (mataData.fromPeerId) {
        mataData.from = mataData.fromPeerId;
      }
      angular.extend(this, {
        timestamp: Date.now(),
        from: undefined,
        needReceipt: false,
        transient: false
      }, mataData);
    }
  }
  toString(data) {
    return JSON.stringify(data || this.content);
  }
  static parse(content, metaData) {
    if (typeof content === 'string') {
      return new Message(content, metaData);
    }
  }
}

class TypedMessage extends Message {
  constructor(content, mataData) {
    super(null, mataData);
    this.content = content;
    this.content.type = 0;
  }
  toString(data) {
    return super.toString(angular.extend({}, data, {
      _lctext: this.content.text,
      _lcattrs: this.content.attr,
      _lctype: this.content.type
    }));
  }
  static parse(content, metaData) {
    if (typeof content._lctype === 0) {
      return new TypedMessage({
        text: content._lctext,
        attr: content._attrs
      }, metaData);
    }
  }
}
class TextMessage extends TypedMessage {
  constructor(content, mataData) {
    if (typeof content === 'string') {
      content = {
        text: content
      };
    }
    super(content, mataData);
    this.content.type = -1;
  }
  toString(data) {
    return super.toString(data);
  }
  static parse(content, metaData) {
    if (typeof content._lctype === -1) {
      return new TextMessage(content, metaData);
    }
    // 兼容现在的 sdk
    if (content.msg.type === 'text') {
      return new TextMessage(content.msg, content);
    }
  }
}

class MessageParser {
  static parse(message) {
    // 这里 sdk 已经包了一层，这里的实现是为了替代这一层包装
    // 暂时先用 sdk 包装后的 message
    for (var Klass of this._messageClasses) {
      try {
        let result = Klass.parse(message);
        if (result !== undefined) {
          return result;
        }
      } catch (e) {}
    }
  }
  static assign(messageClass) {
    if (messageClass && messageClass.parse && messageClass.toString) {
      this._messageClasses.unshift(messageClass);
    } else {
      throw new TypeError('Invalid messageClass.');
    }
  }
}
MessageParser._messageClasses = [];
[Message, TypedMessage, TextMessage].forEach((Klass) => MessageParser.assign(Klass));

angular.module('leancloud-realtime', [])
  .provider('LCRealtimeFactory', function() {
    var realtime;
    if (window && window.AV) {
      realtime = window.AV.realtime;
    }

    this.setRealtime = (r) => realtime = r;

    this.$get = ($rootScope, $q) => function LCRealtimeFactory() {
      if (!realtime) {
        throw new Error('realtime not found window.AV.realtime. It can also be configed via realtimeFactoryProvider.setRealtime().');
      }
      return new Realtime($rootScope, realtime, $q);
    };
    this.$get.$injects = ['$rootScope', '$q'];
  })
  .provider('LCRealtimeMessageParser', function() {
    this.assign = MessageParser.assign.bind(MessageParser);
    this.$get = function() {};
  })
  .value('LCMessage', Message)
  .value('LCTypedMessage', TypedMessage)
  .value('LCTextMessage', TextMessage);