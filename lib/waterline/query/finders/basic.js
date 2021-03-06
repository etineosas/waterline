/**
 * Basic Finder Queries
 */

var usageError = require('../../utils/usageError'),
    utils = require('../../utils/helpers'),
    normalize = require('../../utils/normalize'),
    sorter = require('../../utils/sorter'),
    Deferred = require('../deferred'),
    Joins = require('./joins'),
    Operations = require('./operations'),
    Integrator = require('../integrator'),
    waterlineCriteria = require('waterline-criteria'),
    _ = require('lodash'),
    async = require('async'),
    hasOwnProperty = utils.object.hasOwnProperty,
    callbacks = require('../../utils/callbacksRunner');

module.exports = {

  /**
   * Find a single record that meets criteria
   *
   * @param {Object} criteria to search
   * @param {Function} callback
   * @return Deferred object if no callback
   */

  findOne: function(criteria, cb) {
    var self = this;

    if(typeof criteria === 'function') {
      cb = criteria;
      criteria = null;
    }

    // Check if criteria is an integer or string and normalize criteria
    // to object, using the specified primary key field.
    criteria = normalize.expandPK(self, criteria);

    // Normalize criteria
    criteria = normalize.criteria(criteria);

    this.beforeCallbacks.call(self,criteria.where,function(err){
      if (err) {return cb(err);}
    });

    // Return Deferred or pass to adapter
    if(typeof cb !== 'function') {
      return new Deferred(this, this.findOne, criteria);
    }

    // Transform Search Criteria
    criteria = self._transformer.serialize(criteria);

    // If there was something defined in the criteria that would return no results, don't even
    // run the query and just return an empty result set.
    if(criteria === false) {
      return cb(null, null);
    }

    // Build up an operations set
    var operations = new Operations(self, criteria, 'findOne');

    // Run the operations
    operations.run(function(err, values) {
      if(err) return cb(err);
      if(!values.cache) return cb();

      // If no joins are used grab the only item from the cache and pass to the returnResults
      // function.
      if(!criteria.joins) {
        values = values.cache[self.identity];
        return returnResults(values);
      }

      // If the values are already combined, return the results
      if(values.combined) {
        return returnResults(values.cache[self.identity]);
      }

      // Find the primaryKey of the current model so it can be passed down to the integrator.
      // Use 'id' as a good general default;
      var primaryKey = 'id';

      Object.keys(self._schema.schema).forEach(function(key) {
        if(self._schema.schema[key].hasOwnProperty('primaryKey')) primaryKey = key;
      });


      // Perform in-memory joins
      Integrator(values.cache, criteria.joins, primaryKey, function(err, results) {
        if(err) return cb(err);
        if(!results) return cb();

        // We need to run one last check on the results using the criteria. This allows a self
        // association where we end up with two records in the cache both having each other as
        // embedded objects and we only want one result. However we need to filter any join criteria
        // out of the top level where query so that searchs by primary key still work.
        var tmpCriteria = _.cloneDeep(criteria.where);
        if(!tmpCriteria) tmpCriteria = {};

        criteria.joins.forEach(function(join) {
          if(!hasOwnProperty(join, 'alias')) return;

          // Check for `OR` criteria
          if(hasOwnProperty(tmpCriteria, 'or')) {
            tmpCriteria.or.forEach(function(search) {
              if(!hasOwnProperty(search, join.alias)) return;
              delete search[join.alias];
            });
            return;
          }

          if(!hasOwnProperty(tmpCriteria, join.alias)) return;
          delete tmpCriteria[join.alias];
        });

        // Pass results into Waterline-Criteria
        var _criteria = { where: tmpCriteria };
        results = waterlineCriteria('parent', { parent: results }, _criteria).results;

        // Serialize values coming from an in-memory join before modelizing
        var _results = [];
        results.forEach(function(res) {

          // Go Ahead and perform any sorts on the associated data
          criteria.joins.forEach(function(join) {
            if(!join.criteria) return;
            var c = normalize.criteria(join.criteria);
            if(!c.sort) return;

            var alias = join.alias;
            res[alias] = sorter(res[alias], c.sort);
          });

          var val = self._transformer.serialize(res);
          _results.push(val);
        });

        returnResults(_results);
      });

      function returnResults(results) {

        if(!results) return cb();

        // Normalize results to an array
        if(!Array.isArray(results) && results) results = [results];

        // Unserialize each of the results before attempting any join logic on them
        var unserializedModels = [];
        results.forEach(function(result) {
          unserializedModels.push(self._transformer.unserialize(result));
        });

        var models = [];
        var joins = criteria.joins ? criteria.joins : [];
        var data = new Joins(joins, unserializedModels, self._schema.schema, self.waterline.collections);

        // If `data.models` is invalid (not an array) return early to avoid getting into trouble.
        if (!data || !data.models || !data.models.forEach) {
          return cb(new Error('Values returned from operations set are not an array...'));
        }

        // Create a model for the top level values
        data.models.forEach(function(model) {
          models.push(new self._model(model, data.options));
        });

        cb(null, models[0]);
      }
    });
  },

  /**
   * Find All Records that meet criteria
   *
   * @param {Object} search criteria
   * @param {Object} options
   * @param {Function} callback
   * @return Deferred object if no callback
   */

  find: function(criteria, options, cb) {
    var self = this;

    var usage = utils.capitalize(this.identity) + '.find([criteria],[options]).exec(callback|switchback)';

    if(typeof criteria === 'function') {
      cb = criteria;
      criteria = null;
      options = null;
    }

    if(typeof options === 'function') {
      cb = options;
      options = null;
    }

    // Check if criteria is an integer or string and normalize criteria
    // to object, using the specified primary key field.
    criteria = normalize.expandPK(self, criteria);

    // Normalize criteria
    criteria = normalize.criteria(criteria);

    // Validate Arguments
    if(typeof criteria === 'function' || typeof options === 'criteria') {
      return usageError('Invalid options specified!', usage, cb);
    }

    this.beforeCallbacks.call(self,criteria.where,function(err){
      if (err) return cb(err);
    });

    // Return Deferred or pass to adapter
    if(typeof cb !== 'function') {
      return new Deferred(this, this.find, criteria);
    }

    // If there was something defined in the criteria that would return no results, don't even
    // run the query and just return an empty result set.
    if(criteria === false) {
      return cb(null, []);
    }

    // Fold in options
    if(options === Object(options) && criteria === Object(criteria)) {
      criteria = _.extend({}, criteria, options);
    }

    // Transform Search Criteria
    if (!self._transformer) {
      throw new Error('Waterline can not access transformer-- maybe the context of the method is being overridden?');
    }

    criteria = self._transformer.serialize(criteria);


    // Build up an operations set
    var operations = new Operations(self, criteria, 'find');

    // Run the operations
    operations.run(function(err, values) {
      if(err) return cb(err);
      if(!values.cache) return cb();

      // If no joins are used grab current collection's item from the cache and pass to the returnResults
      // function.
      if(!criteria.joins) {
        values = values.cache[self.identity];
        return returnResults(values);
      }

      // If the values are already combined, return the results
      if(values.combined) {
        return returnResults(values.cache[self.identity]);
      }

      // Find the primaryKey of the current model so it can be passed down to the integrator.
      // Use 'id' as a good general default;
      var primaryKey = 'id';

      Object.keys(self._schema.schema).forEach(function(key) {
        if(self._schema.schema[key].hasOwnProperty('primaryKey')) primaryKey = key;
      });

      // Perform in-memory joins
      Integrator(values.cache, criteria.joins, primaryKey, function(err, results) {
        if(err) return cb(err);
        if(!results) return cb();

        // We need to run one last check on the results using the criteria. This allows a self
        // association where we end up with two records in the cache both having each other as
        // embedded objects and we only want one result. However we need to filter any join criteria
        // out of the top level where query so that searchs by primary key still work.
        var tmpCriteria = _.cloneDeep(criteria.where);
        if(!tmpCriteria) tmpCriteria = {};

        criteria.joins.forEach(function(join) {
          if(!hasOwnProperty(join, 'alias')) return;

          // Check for `OR` criteria
          if(hasOwnProperty(tmpCriteria, 'or')) {
            tmpCriteria.or.forEach(function(search) {
              if(!hasOwnProperty(search, join.alias)) return;
              delete search[join.alias];
            });
            return;
          }

          if(!hasOwnProperty(tmpCriteria, join.alias)) return;
          delete tmpCriteria[join.alias];
        });

        // Pass results into Waterline-Criteria
        var _criteria = { where: tmpCriteria };
        results = waterlineCriteria('parent', { parent: results }, _criteria).results;

        // Serialize values coming from an in-memory join before modelizing
        var _results = [];
        results.forEach(function(res) {

          // Go Ahead and perform any sorts on the associated data
          criteria.joins.forEach(function(join) {
            if(!join.criteria) return;
            var c = normalize.criteria(join.criteria);
            if(!c.sort) return;

            var alias = join.alias;
            res[alias] = sorter(res[alias], c.sort);
          });

          var val = self._transformer.serialize(res);
          _results.push(val);
        });

        returnResults(_results);
      });

      function returnResults(results) {

        if(!results) return cb(null, []);

        // Normalize results to an array
        if(!Array.isArray(results) && results) results = [results];

        // Unserialize each of the results before attempting any join logic on them
        var unserializedModels = [];

        if(results) {
          results.forEach(function(result) {
            unserializedModels.push(self._transformer.unserialize(result));
          });
        }

        var models = [];
        var joins = criteria.joins ? criteria.joins : [];
        var data = new Joins(joins, unserializedModels, self._schema.schema, self.waterline.collections);

        // NOTE:
        // If a "belongsTo" (i.e. HAS_FK) association is null, should it be transformed into
        // an empty array here?  That is not what is happening currently, and it can cause
        // unexpected problems when implementing the native join method as an adapter implementor.
        // ~Mike June 22, 2014

        // If `data.models` is invalid (not an array) return early to avoid getting into trouble.
        if (!data || !data.models || !data.models.forEach) {
          return cb(new Error('Values returned from operations set are not an array...'));
        }

        // Create a model for the top level values
        data.models.forEach(function(model) {
          models.push(new self._model(model, data.options));
        });


        cb(null, models);
      }

    });
  },

  beforeCallbacks:function(criteria,cb){
    var self = this;
    async.series([
      function(cb){
        callbacks.beforeFind(self,criteria,cb);
      }
    ]);
  },

  where: function() {
    this.find.apply(this, Array.prototype.slice.call(arguments));
  },

  select: function() {
    this.find.apply(this, Array.prototype.slice.call(arguments));
  },


  /**
   * findAll
   * [[ Deprecated! ]]
   *
   * @param  {Object}   criteria
   * @param  {Object}   options
   * @param  {Function} cb
   */
  findAll: function(criteria, options, cb) {
    if(typeof criteria === 'function') {
      cb = criteria;
      criteria = null;
      options = null;
    }

    if(typeof options === 'function') {
      cb = options;
      options = null;
    }

    // Return Deferred or pass to adapter
    if(typeof cb !== 'function') {
      return new Deferred(this, this.findAll, criteria);
    }

    cb(new Error('In Waterline >= 0.9, findAll() has been deprecated in favor of find().' +
                '\nPlease visit the migration guide at http://sailsjs.org for help upgrading.'));
  }

};
