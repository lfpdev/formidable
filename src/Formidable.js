/* eslint-disable class-methods-use-this */
/* eslint-disable no-underscore-dangle */

import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import hexoid from 'hexoid';
import once from 'once';
import dezalgo from 'dezalgo';
import { octetstream, querystring, multipart, json } from './plugins/index.js';
import PersistentFile from './PersistentFile.js';
import VolatileFile from './VolatileFile.js';
import DummyParser from './parsers/Dummy.js';
import MultipartParser from './parsers/Multipart.js';
import * as errors from './FormidableError.js';
import FormidableError from './FormidableError.js';

const toHexoId = hexoid(25);
const DEFAULT_OPTIONS = {
  maxFields: 1000,
  maxFieldsSize: 20 * 1024 * 1024,
  maxFiles: 1000,
  maxFileSize: 200 * 1024 * 1024,
  maxTotalFileSize: undefined,
  minFileSize: 1,
  allowEmptyFiles: false,
  keepExtensions: false,
  encoding: 'utf-8',
  hashAlgorithm: false,
  uploadDir: os.tmpdir(),
  enabledPlugins: [octetstream, querystring, multipart, json],
  fileWriteStreamHandler: null,
  defaultInvalidName: 'invalid-name',
  filter() {
    return true;
  },
};

function hasOwnProp(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

class IncomingForm extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (!this.options.maxTotalFileSize) {
      this.options.maxTotalFileSize = this.options.maxFiles * this.options.maxFileSize
    }

    const dir = path.resolve(
      this.options.uploadDir || this.options.uploaddir || os.tmpdir(),
    );

    this.uploaddir = dir;
    this.uploadDir = dir;

    // initialize with null
    [
      'error',
      'headers',
      'type',
      'bytesExpected',
      'bytesReceived',
      '_parser',
    ].forEach((key) => {
      this[key] = null;
    });

    this._setUpRename();

    this._flushing = 0;
    this._fieldsSize = 0;
    this._totalFileSize = 0;
    this._plugins = [];
    this.openedFiles = [];

    this.options.enabledPlugins = []
      .concat(this.options.enabledPlugins)
      .filter(Boolean);

    if (this.options.enabledPlugins.length === 0) {
      throw new FormidableError(
        'expect at least 1 enabled builtin plugin, see options.enabledPlugins',
        errors.missingPlugin,
      );
    }

    this.options.enabledPlugins.forEach((plugin) => {
      this.use(plugin);
    });

    this._setUpMaxFields();
    this._setUpMaxFiles();
  }

  use(plugin) {
    if (typeof plugin !== 'function') {
      throw new FormidableError(
        '.use: expect `plugin` to be a function',
        errors.pluginFunction,
      );
    }
    this._plugins.push(plugin.bind(this));
    return this;
  }

  parse(req, cb) {
    this.pause = () => {
      try {
        req.pause();
      } catch (err) {
        // the stream was destroyed
        if (!this.ended) {
          // before it was completed, crash & burn
          this._error(err);
        }
        return false;
      }
      return true;
    };

    this.resume = () => {
      try {
        req.resume();
      } catch (err) {
        // the stream was destroyed
        if (!this.ended) {
          // before it was completed, crash & burn
          this._error(err);
        }
        return false;
      }

      return true;
    };

    // Setup callback first, so we don't miss anything from data events emitted immediately.
    if (cb) {
      const callback = once(dezalgo(cb));
      this.fields = {};
      let mockFields = '';
      const files = {};

      this.on('field', (name, value) => {
        if (this.type === 'multipart' || this.type === 'urlencoded') {
          if (!hasOwnProp(this.fields, name)) {
            this.fields[name] = [value];
          } else {
            this.fields[name].push(value);
          }
        } else {
          this.fields[name] = value;
        }
      });
      this.on('file', (name, file) => {
        if (!hasOwnProp(files, name)) {
          files[name] = [file];
        } else {
          files[name].push(file);
        }
      });
      this.on('error', (err) => {
        callback(err, this.fields, files);
      });
      this.on('end', () => {
        callback(null, this.fields, files);
      });
    }

    // Parse headers and setup the parser, ready to start listening for data.
    this.writeHeaders(req.headers);

    // Start listening for data.
    req
      .on('error', (err) => {
        this._error(err);
      })
      .on('aborted', () => {
        this.emit('aborted');
        this._error(new FormidableError('Request aborted', errors.aborted));
      })
      .on('data', (buffer) => {
        try {
          this.write(buffer);
        } catch (err) {
          this._error(err);
        }
      })
      .on('end', () => {
        if (this.error) {
          return;
        }
        if (this._parser) {
          this._parser.end();
        }
        this._maybeEnd();
      });

    return this;
  }

  writeHeaders(headers) {
    this.headers = headers;
    this._parseContentLength();
    this._parseContentType();

    if (!this._parser) {
      this._error(
        new FormidableError(
          'no parser found',
          errors.noParser,
          415, // Unsupported Media Type
        ),
      );
      return;
    }

    this._parser.once('error', (error) => {
      this._error(error);
    });
  }

  write(buffer) {
    if (this.error) {
      return null;
    }
    if (!this._parser) {
      this._error(
        new FormidableError('uninitialized parser', errors.uninitializedParser),
      );
      return null;
    }

    this.bytesReceived += buffer.length;
    this.emit('progress', this.bytesReceived, this.bytesExpected);

    this._parser.write(buffer);

    return this.bytesReceived;
  }

  pause() {
    // this does nothing, unless overwritten in IncomingForm.parse
    return false;
  }

  resume() {
    // this does nothing, unless overwritten in IncomingForm.parse
    return false;
  }

  onPart(part) {
    // this method can be overwritten by the user
    this._handlePart(part);
  }

  _handlePart(part) {
    if (part.originalFilename && typeof part.originalFilename !== 'string') {
      this._error(
        new FormidableError(
          `the part.originalFilename should be string when it exists`,
          errors.filenameNotString,
        ),
      );
      return;
    }

    // This MUST check exactly for undefined. You can not change it to !part.originalFilename.

    // todo: uncomment when switch tests to Jest
    // console.log(part);

    // ? NOTE(@tunnckocore): no it can be any falsey value, it most probably depends on what's returned
    // from somewhere else. Where recently I changed the return statements
    // and such thing because code style
    // ? NOTE(@tunnckocore): or even better, if there is no mimetype, then it's for sure a field
    // ? NOTE(@tunnckocore): originalFilename is an empty string when a field?
    if (!part.mimetype) {
      let value = '';
      const decoder = new StringDecoder(
        part.transferEncoding || this.options.encoding,
      );

      part.on('data', (buffer) => {
        this._fieldsSize += buffer.length;
        if (this._fieldsSize > this.options.maxFieldsSize) {
          this._error(
            new FormidableError(
              `options.maxFieldsSize (${this.options.maxFieldsSize} bytes) exceeded, received ${this._fieldsSize} bytes of field data`,
              errors.maxFieldsSizeExceeded,
              413, // Payload Too Large
            ),
          );
          return;
        }
        value += decoder.write(buffer);
      });

      part.on('end', () => {
        this.emit('field', part.name, value);
      });
      return;
    }

    if (!this.options.filter(part)) {
      return;
    }

    this._flushing += 1;

    let fileSize = 0;
    const newFilename = this._getNewName(part);
    const filepath = this._joinDirectoryName(newFilename);
    const file = this._newFile({
      newFilename,
      filepath,
      originalFilename: part.originalFilename,
      mimetype: part.mimetype,
    });
    file.on('error', (err) => {
      this._error(err);
    });
    this.emit('fileBegin', part.name, file);

    file.open();
    this.openedFiles.push(file);

    part.on('data', (buffer) => {
      this._totalFileSize += buffer.length;
      fileSize += buffer.length;
      
      if (this._totalFileSize > this.options.maxTotalFileSize) {
        this._error(
          new FormidableError(
            `options.maxTotalFileSize (${this.options.maxTotalFileSize} bytes) exceeded, received ${this._totalFileSize} bytes of file data`,
            errors.biggerThanTotalMaxFileSize,
            413,
          ),
        );
        return;
      }
      if (buffer.length === 0) {
        return;
      }
      this.pause();
      file.write(buffer, () => {
        this.resume();
      });
    });

    part.on('end', () => {
      if (!this.options.allowEmptyFiles && fileSize === 0) {
        this._error(
          new FormidableError(
            `options.allowEmptyFiles is false, file size should be greather than 0`,
            errors.noEmptyFiles,
            400,
          ),
        );
        return;
      }
      if (fileSize < this.options.minFileSize) {
        this._error(
          new FormidableError(
            `options.minFileSize (${this.options.minFileSize} bytes) inferior, received ${fileSize} bytes of file data`,
            errors.smallerThanMinFileSize,
            400,
          ),
        );
        return;
      }
      if (fileSize > this.options.maxFileSize) {
        this._error(
          new FormidableError(
            `options.maxFileSize (${this.options.maxFileSize} bytes), received ${fileSize} bytes of file data`,
            errors.biggerThanMaxFileSize,
            413,
          ),
        );
        return;
      }

      file.end(() => {
        this._flushing -= 1;
        this.emit('file', part.name, file);
        this._maybeEnd();
      });
    });
  }

  // eslint-disable-next-line max-statements
  _parseContentType() {
    if (this.bytesExpected === 0) {
      this._parser = new DummyParser(this, this.options);
      return;
    }

    if (!this.headers['content-type']) {
      this._error(
        new FormidableError(
          'bad content-type header, no content-type',
          errors.missingContentType,
          400,
        ),
      );
      return;
    }

    const results = [];
    const _dummyParser = new DummyParser(this, this.options);

    // eslint-disable-next-line no-plusplus
    for (let idx = 0; idx < this._plugins.length; idx++) {
      const plugin = this._plugins[idx];

      let pluginReturn = null;

      try {
        pluginReturn = plugin(this, this.options) || this;
      } catch (err) {
        // directly throw from the `form.parse` method;
        // there is no other better way, except a handle through options
        const error = new FormidableError(
          `plugin on index ${idx} failed with: ${err.message}`,
          errors.pluginFailed,
          500,
        );
        error.idx = idx;
        throw error;
      }

      Object.assign(this, pluginReturn);

      // todo: use Set/Map and pass plugin name instead of the `idx` index
      this.emit('plugin', idx, pluginReturn);
      results.push(pluginReturn);
    }

    this.emit('pluginsResults', results);

    // NOTE: probably not needed, because we check options.enabledPlugins in the constructor
    // if (results.length === 0 /* && results.length !== this._plugins.length */) {
    //   this._error(
    //     new Error(
    //       `bad content-type header, unknown content-type: ${this.headers['content-type']}`,
    //     ),
    //   );
    // }
  }

  _error(err, eventName = 'error') {
    // if (!err && this.error) {
    //   this.emit('error', this.error);
    //   return;
    // }
    if (this.error || this.ended) {
      return;
    }

    this.error = err;
    this.emit(eventName, err);

    if (Array.isArray(this.openedFiles)) {
      this.openedFiles.forEach((file) => {
        file.destroy();
      });
    }
  }

  _parseContentLength() {
    this.bytesReceived = 0;
    if (this.headers['content-length']) {
      this.bytesExpected = parseInt(this.headers['content-length'], 10);
    } else if (this.headers['transfer-encoding'] === undefined) {
      this.bytesExpected = 0;
    }

    if (this.bytesExpected !== null) {
      this.emit('progress', this.bytesReceived, this.bytesExpected);
    }
  }

  _newParser() {
    return new MultipartParser(this.options);
  }

  _newFile({ filepath, originalFilename, mimetype, newFilename }) {
    return this.options.fileWriteStreamHandler
      ? new VolatileFile({
          newFilename,
          filepath,
          originalFilename,
          mimetype,
          createFileWriteStream: this.options.fileWriteStreamHandler,
          hashAlgorithm: this.options.hashAlgorithm,
        })
      : new PersistentFile({
          newFilename,
          filepath,
          originalFilename,
          mimetype,
          hashAlgorithm: this.options.hashAlgorithm,
        });
  }

  _getFileName(headerValue) {
    // matches either a quoted-string or a token (RFC 2616 section 19.5.1)
    const m = headerValue.match(
      /\bfilename=("(.*?)"|([^()<>{}[\]@,;:"?=\s/\t]+))($|;\s)/i,
    );
    if (!m) return null;

    const match = m[2] || m[3] || '';
    let originalFilename = match.substr(match.lastIndexOf('\\') + 1);
    originalFilename = originalFilename.replace(/%22/g, '"');
    originalFilename = originalFilename.replace(/&#([\d]{4});/g, (_, code) =>
      String.fromCharCode(code),
    );

    return originalFilename;
  }

  _getExtension(str) {
    if (!str) {
      return '';
    }

    const basename = path.basename(str);
    const firstDot = basename.indexOf('.');
    const lastDot = basename.lastIndexOf('.');
    const extname = path.extname(basename).replace(/(\.[a-z0-9]+).*/i, '$1');

    if (firstDot === lastDot) {
      return extname;
    }

    return basename.slice(firstDot, lastDot) + extname;
  }

  _joinDirectoryName(name) {
    const newPath = path.join(this.uploadDir, name);

    // prevent directory traversal attacks
    if (!newPath.startsWith(this.uploadDir)) {
      return path.join(this.uploadDir, this.options.defaultInvalidName);
    }

    return newPath;
  }

  _setUpRename() {
    const hasRename = typeof this.options.filename === 'function';
    if (hasRename) {
      this._getNewName = (part) => {
        let ext = '';
        let name = this.options.defaultInvalidName;
        if (part.originalFilename) {
          // can be null
          ({ ext, name } = path.parse(part.originalFilename));
          if (this.options.keepExtensions !== true) {
            ext = '';
          }
        }
        return this.options.filename.call(this, name, ext, part, this);
      };
    } else {
      this._getNewName = (part) => {
        const name = toHexoId();

        if (part && this.options.keepExtensions) {
          const originalFilename =
            typeof part === 'string' ? part : part.originalFilename;
          return `${name}${this._getExtension(originalFilename)}`;
        }

        return name;
      };
    }
  }

  _setUpMaxFields() {
    if (this.options.maxFields !== 0) {
      let fieldsCount = 0;
      this.on('field', () => {
        fieldsCount += 1;
        if (fieldsCount > this.options.maxFields) {
          this._error(
            new FormidableError(
              `options.maxFields (${this.options.maxFields}) exceeded`,
              errors.maxFieldsExceeded,
              413,
            ),
          );
        }
      });
    }
  }

  _setUpMaxFiles() {
    if (this.options.maxFiles !== 0) {
      let fileCount = 0;
      this.on('file', () => {
        fileCount += 1;
        if (fileCount > this.options.maxFiles) {
          this._error(
            new FormidableError(
              `options.maxFiles (${this.options.maxFiles}) exceeded`,
              errors.maxFilesExceeded,
              413,
            ),
          );
        }
      });
    }
  }

  _maybeEnd() {
    // console.log('ended', this.ended);
    // console.log('_flushing', this._flushing);
    // console.log('error', this.error);
    if (!this.ended || this._flushing || this.error) {
      return;
    }

    this.emit('end');
  }
}

export default IncomingForm;
export { DEFAULT_OPTIONS };
