//     Backbone.DirectAttributes 0.0.1
//
//     (c) 2012 Jeremy Fairbank
//     Backbone.DirectAttributes may be freely distributed under the MIT license.

Backbone.DirectAttributes = (function(Backbone) {
  // Helpers
  // -------

  var _hasAttribute = function(model, key) {
    return typeof model.get(key) != 'undefined';
  };

  var toClassCase = function(str) {
    str = str.replace(/_([a-zA-Z])?/g, function(all, $1) {
      return $1 ? $1.toUpperCase() : '';
    });

    return str.substr(0, 1).toUpperCase() + str.substr(1);
  };

  var keys = ('keys' in Object ? Object.keys : function(obj) {
    var ret = [];
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) {
        ret.push(key);
      }
    }
    return ret;
  });

  // Direct Attribute
  // ----------------

  var DirectAttribute = function(das, model, key, options) {
    this.das = das;
    this.model = model;
    this.key = key;
    this.jsonKey = options.jsonKey || key;

    var defaults = {
      entityType: null,
      done: null,
      attributeName: null,
      constructorOptions: {},
      setupNull: false
    };

    options = _.extend({}, defaults, options);
    options.setup = options.setup || this._defaultSetup();

    this.options = options;
    this.attributeName = options.attributeName || this.key;
  };

  _.extend(DirectAttribute.prototype, {
    runCallback: function() {
      var self = this;
      var options = this.options;
      return function() {
        var args = [self.key, self.attributeName, options.entityType];

        if (options.done) {
          args.push(_.bind(options.done, self.model));
        }

        options.setup.apply(self.model, args);
        self.das.updateRegistry(self.attributeName);
      };
    },

    setupIfNull: function() {
      return this.options.setupNull === true;
    },

    _defaultSetup: function() {
      var da = this;

      // Return default setup function, `this` context is the model
      return function(key, attributeName, entityType, done) {
        if (!_hasAttribute(this, key) && !da.setupIfNull()) {
          return;
        }

        var value = this.get(key);
        if (!da.setupIfNull() && (typeof value == 'undefined' || value === null)) {
          return;
        }

        var constructorOptions = da.options.constructorOptions;
        if (typeof constructorOptions == 'function') {
          constructorOptions = constructorOptions.call(this);
        }

        this[attributeName] = entityType ? new entityType(value, constructorOptions) : value;
        this.unset(key, { silent: true });
        
        if (done) {
          done();
        }
      };
    }
  });

  // Direct Attributes
  // -----------------

  var DirectAttributes = function(model) {
    this.model = model;
    this._attributes = {};
    this._attributeHasFn = [];
    this._fetchRunList = {};
    this._registry = {};
    
    // Set up methods
    this._setupHasDirect();
    this._setupJSON();
    this._setupFetch();
    this._setupAttrAccessor();
  };

  _.extend(DirectAttributes.prototype, {
    updateRegistry: function(attributeName) {
      this._registry[attributeName] = attributeName;
    },

    addAttribute: function(key, options) {
      // Direct attribute
      var da = new DirectAttribute(this, this.model, key, options);
      this._attributes[da.attributeName] = da;

      // Add to fetch and run now if in model attributes
      var run = da.runCallback();

      if (_hasAttribute(this.model, key) || da.setupIfNull()) {
        run();
      }

      this._addToFetchList(da.attributeName, run);

      // Has method
      var fnName = this._setupHas(da.attributeName);
      this._attributeHasFn.push(fnName);
    },

    remove: function() {
      this._revertToOrigFetch();
      this._removeAllHas();
      this._revertToOrigJSON();
    },

    _setupAttrAccessor: function() {
      var self = this;

      this.model.getDirectAttributeNames = function() {
        return keys(self._registry);
      };

      this.model.isDirectAttribute = function(key) {
        return self._registry.hasOwnProperty(key);
      };
    },

    _addToFetchList: function(key, run) {
      this._fetchRunList[key] = run;
    },

    _runFetchSetup: function(cb) {
      var fetchList = this._fetchRunList;

      for (var key in fetchList) {
        if (fetchList.hasOwnProperty(key)) {
          fetchList[key]();
        }
      }

      if (cb) {
        cb();
      }
    },

    _setupFetch: function() {
      if (this._usingModifiedFetch) {
        return;
      }

      var self = this;
      var model = this.model;
      var origFetch = this._origFetch = model.fetch;

      this._usingModifiedFetch = true;

      model.fetch = function(options) {
        var model = this;
        var dfd = $.Deferred();
        var success, error;
        
        // Get callbacks
        if (options) {
          success = options.success;
          error = options.error;
          delete options.success;
          delete options.error;
        }

        // Get original promise
        var promise = Backbone.Model.prototype.fetch.call(this, options);

        promise.done(function() {
          var args = arguments || [];
          self._runFetchSetup(function() {
            dfd.resolve.apply(model, args);

            if (success) {
              success.apply(model, args);
            }
          });
        });

        promise.fail(function() {
          var args = arguments || [];
          dfd.reject.apply(model, args);
          if (error) {
            error.apply(model, args);
          }
        });

        return dfd.promise();
      };
    },

    _revertToOrigFetch: function() {
      this.model.fetch = this._origFetch;
      this._usingModifiedFetch = false;
      this._origFetch = null;
    },

    _setupHasDirect: function() {
      var self = this;
      this.model.hasDirect = function(key) {
        return self._attributes.hasOwnProperty(key) && this[key] != null;
      };
    },

    _setupHas: function(key) {
      var fnName = 'has' + toClassCase(key);

      if (fnName == 'hasChanged' || fnName == 'hasOwnProperty') {
        var error = new Error("Can't use `" + key + "` with `" + fnName + "` method.");
        throw error;
      }

      this.model[fnName] = function() {
        return this.hasDirect(key);
      };

      return fnName;
    },

    _removeAllHas: function() {
      var model = this.model;
      var attributeHasFn = this._attributeHasFn;

      delete model.hasDirect;

      for (var i = 0, l = attributeHasFn.length; i < l; i++) {
        delete model[attributeHasFn[i]];
      }
    },

    _setupJSON: function() {
      if (this._usingDirectJSON) {
        return;
      }

      var self = this;
      var model = this.model;
      var origToJSON = this._origToJSON = model.toJSON;
      this._usingDirectJSON = true;

      model.toJSON = function() {
        var attributes = self._attributes;
        var data = origToJSON.call(model);
        var attribute = null;

        for (var attrKey in attributes) {
          attribute = attributes[attrKey];
          
          if (model[attrKey] && model[attrKey].toJSON) {
            data[attribute.jsonKey] = model[attrKey].toJSON();
          }
        }

        return data;
      };
    },

    _revertToOrigJSON: function() {
      this.model.toJSON = this._origToJSON;
      this._usingDirectJSON = false;
      this._origToJSON = null;
    }
  });

  // Public API
  // ----------

  return {
    add: function(model) {
      if (model._directAttributes) {
        return;
      }

      var das = model._directAttributes = new DirectAttributes(model);

      model.setupDirectAttribute = function(key, options) {
        das.addAttribute(key, options);
      };
    },

    remove: function(model) {
      if (!model._directAttributes) {
        return;
      }

      model._directAttributes.remove();
      delete model._directAttributes;
      delete model.setupDirectAttribute;
      delete model.getDirectAttributeNames;
      delete model.isDirectAttribute;
    }
  };
})(Backbone);
