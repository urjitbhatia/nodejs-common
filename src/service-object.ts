/*!
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*!
 * @module common/service-object
 */

import * as arrify from 'arrify';
import * as extend from 'extend';
import * as is from 'is';
import * as r from 'request';
import { EventEmitter } from 'events';

/**
 * @type {module:common/util}
 * @private
 */
const util = require('./util');

export interface GoogleError extends Error {
  code: number;
  errors?: Array<{
    reason?: string;
  }>;
}

export type ExtendedRequestOptions = r.Options & {
  interceptors_?: any;
  uri: string;
};

export interface ExistsCallback {
  (err: Error|null, exists?: boolean): void;
}

export interface ServiceObjectConfig {
  /**
   * The base URL to make API requests to.
   */
  baseUrl?: string;

  /**
   * The method which creates this object.
   */
  createMethod?: Function;

  /**
   * The identifier of the object. For example, the name of a Storage bucket or Pub/Sub topic.
   */
  id?: string;

  /**
   * A map of each method name that should be inherited.
   */
  methods?: Methods;

  /**
   * The parent service instance. For example, an instance of Storage if the object is Bucket.
   */
  parent?: {};
}

export interface Methods {
  [methodName: string]: any;
}

export interface CreateOptions {

}

export interface CodeError extends Error {
  code: number;
}

export interface InstanceResponseCallback {
  (err: GoogleError|null, instance: any, apiResponse: r.Response): void;
}

export interface DeleteCallback {
  (err: Error|null, apiResponse?: r.Response): void;
}

export interface GetConfig {
  /**
   * Create the object if it doesn't already exist.
   */
  autoCreate?: boolean;
}

/**
 * ServiceObject is a base class, meant to be inherited from by a "service
 * object," like a BigQuery dataset or Storage bucket.
 *
 * Most of the time, these objects share common functionality; they can be
 * created or deleted, and you can get or set their metadata.
 *
 * By inheriting from this class, a service object will be extended with these
 * shared behaviors. Note that any method can be overridden when the service
 * object requires specific behavior.
 */
class ServiceObject extends EventEmitter {

  private metadata: any;
  baseUrl?: string;
  private parent: any;
  private id?: string;
  private createMethod?: Function;
  private methods: Methods;
  private interceptors: any;
  protected Promise: any;

  /*
  * @constructor
  * @alias module:common/service-object
  *
  * @private
  *
  * @param {object} config - Configuration object.
  * @param {string} config.baseUrl - The base URL to make API requests to.
  * @param {string} config.createMethod - The method which creates this object.
  * @param {string=} config.id - The identifier of the object. For example, the
  *     name of a Storage bucket or Pub/Sub topic.
  * @param {object=} config.methods - A map of each method name that should be inherited.
  * @param {object} config.methods[].reqOpts - Default request options for this
  *     particular method. A common use case is when `setMetadata` requires a
  *     `PUT` method to override the default `PATCH`.
  * @param {object} config.parent - The parent service instance. For example, an
  *     instance of Storage if the object is Bucket.
  */
  constructor(config: ServiceObjectConfig) {
    super();
    this.metadata = {};
    this.baseUrl = config.baseUrl;
    this.parent = config.parent; // Parent class.
    this.id = config.id; // Name or ID (e.g. dataset ID, bucket name, etc).
    this.createMethod = config.createMethod;
    this.methods = config.methods || {};
    this.interceptors = [];
    this.Promise = this.parent ? this.parent.Promise : undefined;

    if (config.methods) {
      const allMethodNames = Object.keys(ServiceObject.prototype);
      allMethodNames
        .filter((methodName) => {
          return (
            // All ServiceObjects need `request`.
            !/^request/.test(methodName) &&
            // The ServiceObject didn't redefine the method.
            this[methodName] === ServiceObject.prototype[methodName] &&
            // This method isn't wanted.
            !config.methods![methodName]
          );
        })
        .forEach((methodName) => {
          this[methodName] = undefined;
        });
    }
  }

  /**
   * Create the object.
   *
   * @param {object=} options - Configuration object.
   * @param {function} callback - The callback function.
   * @param {?error} callback.err - An error returned while making this request.
   * @param {object} callback.instance - The instance.
   * @param {object} callback.apiResponse - The full API response.
   */
  create(options: CreateOptions, callback?: InstanceResponseCallback);
  create(callback?: InstanceResponseCallback);
  create(optionsOrCallback?: CreateOptions|InstanceResponseCallback, callback?: InstanceResponseCallback) {
    const self = this;
    const args: any[] = [this.id];

    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
    }

    if (typeof optionsOrCallback === 'object') {
      args.push(optionsOrCallback);
    }

    // Wrap the callback to return *this* instance of the object, not the newly-
    // created one.
    function onCreate(err: Error, instance: any) {
      const args = [].slice.call(arguments);

      if (!err) {
        self.metadata = instance.metadata;
        args[1] = self; // replace the created `instance` with this one.
      }

      callback!.apply(null, args);
    }

    args.push(onCreate);

    this.createMethod!.apply(null, args);
  }

  /**
   * Delete the object.
   *
   * @param {function=} callback - The callback function.
   * @param {?error} callback.err - An error returned while making this request.
   * @param {object} callback.apiResponse - The full API response.
   */
  delete(callback?: DeleteCallback) {
    const methodConfig = this.methods.delete || {};
    callback = callback || util.noop;

    const reqOpts = extend(
      {
        method: 'DELETE',
        uri: '',
      },
      methodConfig.reqOpts
    );

    // The `request` method may have been overridden to hold any special behavior.
    // Ensure we call the original `request` method.
    this.request(reqOpts, (err: Error|null, resp: r.Response) => {
      callback!(err, resp);
    });
  }

  /**
   * Check if the object exists.
   *
   * @param {function} callback - The callback function.
   * @param {?error} callback.err - An error returned while making this request.
   * @param {boolean} callback.exists - Whether the object exists or not.
   */
  exists(callback: ExistsCallback) {
    this.get(err => {
      if (err) {
        if (err.code === 404) {
          callback(null, false);
        } else {
          callback(err);
        }
        return;
      }
      callback(null, true);
    });
  }

  /**
   * Get the object if it exists. Optionally have the object created if an options
   * object is provided with `autoCreate: true`.
   *
   * @param {object=} config - The configuration object that will be used to
   *     create the object if necessary.
   * @param {boolean} config.autoCreate - Create the object if it doesn't already exist.
   * @param {function} callback - The callback function.
   * @param {?error} callback.err - An error returned while making this request.
   * @param {object} callback.instance - The instance.
   * @param {object} callback.apiResponse - The full API response.
   */
  get(config: GetConfig, callback?: InstanceResponseCallback);
  get(callback: InstanceResponseCallback);
  get(configOrCallback: GetConfig|InstanceResponseCallback, callback?: InstanceResponseCallback) {
    const self = this;

    let config: GetConfig = {};
    if (typeof configOrCallback === 'function') {
      callback = configOrCallback;
    }

    if (typeof configOrCallback === 'object') {
      config = configOrCallback;
    }

    const autoCreate = config.autoCreate && is.fn(this.create);
    delete config.autoCreate;

    function onCreate(err: CodeError|null, instance: any, apiResponse: r.Response) {
      if (err) {
        if (err.code === 409) {
          self.get(config, callback);
          return;
        }

        callback!(err, null, apiResponse);
        return;
      }

      callback!(null, instance, apiResponse);
    }

    this.getMetadata((e: Error|null, metadata: any) => {
      const err = e as GoogleError;
      if (err) {
        if (err.code === 404 && autoCreate) {
          const args: any[] = [];

          if (!is.empty(config)) {
            args.push(config);
          }

          args.push(onCreate);

          self.create.apply(self, args);
          return;
        }

        callback!(err, null, metadata);
        return;
      }

      callback!(null, self, metadata);
    });
  }

  /**
   * Get the metadata of this object.
   *
   * @param {function} callback - The callback function.
   * @param {?error} callback.err - An error returned while making this request.
   * @param {object} callback.metadata - The metadata for this object.
   * @param {object} callback.apiResponse - The full API response.
   */
  getMetadata(callback: (err: Error|null, metadata?: any, apiResponse?: r.Response) => void) {
    const self = this;

    const methodConfig = this.methods.getMetadata || {};

    const reqOpts = extend(
      {
        uri: '',
      },
      methodConfig.reqOpts
    );

    // The `request` method may have been overridden to hold any special behavior.
    // Ensure we call the original `request` method.
    this.request(reqOpts, (err: GoogleError|null, resp?: r.Response) => {
      if (err) {
        callback(err, null, resp);
        return;
      }

      self.metadata = resp;

      callback(null, self.metadata, resp);
    });
  }

  /**
   * Set the metadata for this object.
   *
   * @param {object} metadata - The metadata to set on this object.
   * @param {function=} callback - The callback function.
   * @param {?error} callback.err - An error returned while making this request.
   * @param {object} callback.instance - The instance.
   * @param {object} callback.apiResponse - The full API response.
   */
  setMetadata(metadata: any, callback?: (err: Error|null, resp?: r.Response) => void) {
    const self = this;

    callback = callback || util.noop;

    const methodConfig = this.methods.setMetadata || {};

    const reqOpts = extend(
      true,
      {
        method: 'PATCH',
        uri: '',
        json: metadata,
      },
      methodConfig.reqOpts
    );

    // The `request` method may have been overridden to hold any special behavior.
    // Ensure we call the original `request` method.
    this.request(reqOpts, function(err: Error|null, resp?: r.Response) {
      if (err) {
        callback!(err, resp);
        return;
      }

      self.metadata = resp;

      callback!(null, resp);
    });
  }

  /**
   * Make an authenticated API request.
   *
   * @private
   *
   * @param {object} reqOpts - Request options that are passed to `request`.
   * @param {string} reqOpts.uri - A URI relative to the baseUrl.
   * @param {function} callback - The callback function passed to `request`.
   */
  request_(reqOpts: ExtendedRequestOptions, callback?: Function) {
    reqOpts = extend(true, {}, reqOpts);

    const isAbsoluteUrl = reqOpts.uri.indexOf('http') === 0;

    const uriComponents = [this.baseUrl, this.id || '', reqOpts.uri];

    if (isAbsoluteUrl) {
      uriComponents.splice(0, uriComponents.indexOf(reqOpts.uri));
    }

    reqOpts.uri = uriComponents
      .filter(x => x!.trim()) // Limit to non-empty strings.
      .map((uriComponent: any) => {
        const trimSlashesRegex = /^\/*|\/*$/g;
        return uriComponent.replace(trimSlashesRegex, '');
      })
      .join('/');

    const childInterceptors = arrify(reqOpts.interceptors_);
    const localInterceptors = [].slice.call(this.interceptors);

    reqOpts.interceptors_ = childInterceptors.concat(localInterceptors);

    if (!callback) {
      return this.parent.requestStream(reqOpts);
    }

    this.parent.request(reqOpts, callback);
  }

  /**
   * Make an authenticated API request.
   *
   * @private
   *
   * @param {object} reqOpts - Request options that are passed to `request`.
   * @param {string} reqOpts.uri - A URI relative to the baseUrl.
   * @param {function} callback - The callback function passed to `request`.
   */
  request(reqOpts: ExtendedRequestOptions, callback: Function) {
    this.request_(reqOpts, callback);
  }

  /**
   * Make an authenticated API request.
   *
   * @private
   *
   * @param {object} reqOpts - Request options that are passed to `request`.
   * @param {string} reqOpts.uri - A URI relative to the baseUrl.
   */
  requestStream(reqOpts: ExtendedRequestOptions) {
    return this.request_(reqOpts);
  }
}

util.promisifyAll(ServiceObject);

export {ServiceObject};

