// ==========================================================================
// Project:  Ember Metal
// Copyright: ©2011 Strobe Inc. and contributors.
// License:   Licensed under MIT license (see license.js)
// ==========================================================================

require('ember-metal/core');
require('ember-metal/platform');
require('ember-metal/utils');

var o_create = Ember.create,
    meta = Ember.meta,
    metaPath = Ember.metaPath,
    guidFor = Ember.guidFor,
    a_slice = [].slice;

/**
  The event system uses a series of nested hashes to store listeners on an
  object. When a listener is registered, or when an event arrives, these
  hashes are consulted to determine which target and action pair to invoke.

  The hashes are stored in the object's meta hash, and look like this:

      // Object's meta hash
      {
        listeners: {               // variable name: `listenerSet`
          "foo:changed": {         // variable name: `targetSet`
            [targetGuid]: {        // variable name: `actionSet`
              [methodGuid]: {      // variable name: `action`
                target: [Object object],
                method: [Function function],
                xform: [Function function]
              }
            }
          }
        }
      }

*/

// Gets the set of all actions, keyed on the guid of each action's
// method property.
/** @private */
function actionSetFor(obj, eventName, target, writable) {
  return metaPath(obj, ['listeners', eventName, guidFor(target)], writable);
}

// Gets the set of all targets, keyed on the guid of each action's
// target property.
/** @private */
function targetSetFor(obj, eventName) {
  var listenerSet = meta(obj, false).listeners;
  if (!listenerSet) { return false; }

  return listenerSet[eventName] || false;
}

// TODO: This knowledge should really be a part of the
// meta system.
var SKIP_PROPERTIES = { __ember_source__: true };

/** @private */
function iterateSet(targetSet, callback, params) {
  if (!targetSet) { return false; }
  // Iterate through all elements of the target set
  for(var targetGuid in targetSet) {
    if (SKIP_PROPERTIES[targetGuid]) { continue; }

    var actionSet = targetSet[targetGuid];
    if (actionSet) {
      // Iterate through the elements of the action set
      for(var methodGuid in actionSet) {
        if (SKIP_PROPERTIES[methodGuid]) { continue; }

        var action = actionSet[methodGuid];
        if (action) {
          if (callback(action, params) === true) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** @private */
function invokeAction(action, params) {
  var method = action.method, target = action.target, xform = action.xform;
  // If there is no target, the target is the object
  // on which the event was fired.
  if (!target) { target = params[0]; }
  if ('string' === typeof method) { method = target[method]; }

  // Listeners can provide an `xform` function, which can perform
  // arbitrary transformations, such as changing the order of
  // parameters.
  //
  // This is primarily used by ember-runtime's observer system, which
  // provides a higher level abstraction on top of events, including
  // dynamically looking up current values and passing them into the
  // registered listener.
  if (xform) {
    xform(target, method, params);
  } else {
    method.apply(target, params);
  }
}

/**
  The parameters passed to an event listener are not exactly the
  parameters passed to an observer. if you pass an xform function, it will
  be invoked and is able to translate event listener parameters into the form
  that observers are expecting.

  @memberOf Ember
*/
function addListener(obj, eventName, target, method, xform) {
  Ember.assert("You must pass at least an object and event name to Ember.addListener", !!obj && !!eventName);

  if (!method && 'function' === typeof target) {
    method = target;
    target = null;
  }

  var actionSet = actionSetFor(obj, eventName, target, true),
      methodGuid = guidFor(method);

  if (!actionSet[methodGuid]) {
    actionSet[methodGuid] = { target: target, method: method, xform: xform };
  } else {
    actionSet[methodGuid].xform = xform; // used by observers etc to map params
  }

  if ('function' === typeof obj.didAddListener) {
    obj.didAddListener(eventName, target, method);
  }
}

/** @memberOf Ember */
function removeListener(obj, eventName, target, method) {
  if (!method && 'function' === typeof target) {
    method = target;
    target = null;
  }

  var actionSet = actionSetFor(obj, eventName, target, true),
      methodGuid = guidFor(method);

  // we can't simply delete this parameter, because if we do, we might
  // re-expose the property from the prototype chain.
  if (actionSet && actionSet[methodGuid]) { actionSet[methodGuid] = null; }

  if (obj && 'function'===typeof obj.didRemoveListener) {
    obj.didRemoveListener(eventName, target, method);
  }
}

// Suspend listener during callback.
//
// This should only be used by the target of the event listener
// when it is taking an action that would cause the event, e.g.
// an object might suspend its property change listener while it is
// setting that property.
/** @private */
function suspendListener(obj, eventName, target, method, callback) {
  if (!method && 'function' === typeof target) {
    method = target;
    target = null;
  }

  var actionSet = actionSetFor(obj, eventName, target, true),
      methodGuid = guidFor(method),
      action = actionSet && actionSet[methodGuid];

  actionSet[methodGuid] = null;
  try {
    return callback.call(target);
  } finally {
    actionSet[methodGuid] = action;
  }
}

// returns a list of currently watched events
/** @memberOf Ember */
function watchedEvents(obj) {
  var listeners = meta(obj, false).listeners, ret = [];

  if (listeners) {
    for(var eventName in listeners) {
      if (!SKIP_PROPERTIES[eventName] && listeners[eventName]) {
        ret.push(eventName);
      }
    }
  }
  return ret;
}

/** @memberOf Ember */
function sendEvent(obj, eventName) {
  // first give object a chance to handle it
  if (obj !== Ember && 'function' === typeof obj.sendEvent) {
    obj.sendEvent.apply(obj, a_slice.call(arguments, 1));
  }

  iterateSet(targetSetFor(obj, eventName), invokeAction, arguments);
  return true;
}

/** @memberOf Ember */
function deferEvent(obj, eventName) {
  var targetSet = targetSetFor(obj, eventName), actions = [], params = arguments;
  iterateSet(targetSet, function (action) {
    actions.push(action);
  });

  return function() {
    if (obj !== Ember && 'function' === typeof obj.sendEvent) {
      obj.sendEvent.apply(obj, a_slice.call(params, 1));
    }

    for (var i=0, len=actions.length; i < len; ++i) {
      invokeAction(actions[i], params);
    }
  };
}

/** @memberOf Ember */
function hasListeners(obj, eventName) {
  var targetSet = targetSetFor(obj, eventName);
  if (iterateSet(targetSet, function() { return true; })) {
    return true;
  }

  // no listeners!  might as well clean this up so it is faster later.
  var set = metaPath(obj, ['listeners'], true);
  set[eventName] = null;

  return false;
}

/** @memberOf Ember */
function listenersFor(obj, eventName) {
  var targetSet = targetSetFor(obj, eventName), ret = [];
  iterateSet(targetSet, function (action) {
    ret.push([action.target, action.method]);
  });
  return ret;
}

Ember.addListener = addListener;
Ember.removeListener = removeListener;
Ember._suspendListener = suspendListener;
Ember.sendEvent = sendEvent;
Ember.hasListeners = hasListeners;
Ember.watchedEvents = watchedEvents;
Ember.listenersFor = listenersFor;
Ember.deferEvent = deferEvent;
