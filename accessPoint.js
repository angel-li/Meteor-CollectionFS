var APUpload = function(fsFile, data, start) {
  var self = this;
  check(fsFile, FS.File);
  if (!EJSON.isBinary(data))
    throw new Error("APUpload expects binary data");

  if (typeof start !== "number")
    start = 0;

  // Load the complete FS.File instance from the linked collection
  fsFile = fsFile.fetch();

  // collection must exist or fetch would have errored
  var collection = _collections[fsFile.collectionName];

  if (typeof Package !== 'object' || !Package.insecure) {
    // Call user validators; use the "insert" validators
    // since uploading is part of insert.
    // Any deny returns true means denied.
    if (_.any(collection.files._validators.insert.deny, function(validator) {
      return validator(self.userId, fsFile);
    })) {
      throw new Meteor.Error(403, "Access denied");
    }
    // Any allow returns true means proceed. Throw error if they all fail.
    if (_.all(collection.files._validators.insert.allow, function(validator) {
      return !validator(self.userId, fsFile);
    })) {
      throw new Meteor.Error(403, "Access denied");
    }
  }

  // Save chunk and, if it's the last chunk, kick off storage
  TempStore.saveChunk(fsFile, data, start, function(err, done) {
    if (err) {
      throw new Error("Unable to load binary chunk at position " + start + ": " + err.message);
    }
    if (done) {
      // We are done loading all bytes
      // so we should load the temp files into the actual fsFile now
      self.unblock();
      TempStore.getDataForFile(fsFile, function(err, fsFileWithData) {
        if (err) {
          throw err;
        } else {
          // Save file to stores
          fsFileWithData.put();
        }
      });
    }
  });
};

// Returns the data for the copyName copy of fsFile
var APDownload = function(fsFile, copyName, start, end) {
  var self = this;
  check(fsFile, FS.File);
  check(copyName, String);
  check(start, Match.Optional(Number));
  check(end, Match.Optional(Number));

  self.unblock();

  // Load the complete FS.File instance from the linked collection
  fsFile = fsFile.fetch();

  // collection must exist or fetch would have errored
  var collection = _collections[fsFile.collectionName];

  if (typeof Package !== 'object' || !Package.insecure) {
    // Call user validators; use the custom "download" validators
    // since uploading is part of insert.
    // Any deny returns true means denied.
    if (_.any(collection._validators.download.deny, function(validator) {
      return validator(self.userId, fsFile);
    })) {
      throw new Meteor.Error(403, "Access denied");
    }
    // Any allow returns true means proceed. Throw error if they all fail.
    if (_.all(collection._validators.download.allow, function(validator) {
      return !validator(self.userId, fsFile);
    })) {
      throw new Meteor.Error(403, "Access denied");
    }
  }

  return fsFile.get(copyName, start, end);
};

// Deletes fsFile.
// Always deletes the entire file and all copies, even if a specific
// selector is passed. We don't allow deleting individual copies.
var APDelete = function(fsFile) {
  var self = this;
  check(fsFile, FS.File);

  self.unblock();

  // Load the complete FS.File instance from the linked collection
  fsFile = fsFile.fetch();

  // collection must exist or fetch would have errored
  var collection = _collections[fsFile.collectionName];

  if (typeof Package !== 'object' || !Package.insecure) {
    // Call user validators; use the "remove" validators
    // since uploading is part of insert.
    // Any deny returns true means denied.
    if (_.any(collection.files._validators.remove.deny, function(validator) {
      return validator(self.userId, fsFile);
    })) {
      throw new Meteor.Error(403, "Access denied");
    }
    // Any allow returns true means proceed. Throw error if they all fail.
    if (_.all(collection.files._validators.remove.allow, function(validator) {
      return !validator(self.userId, fsFile);
    })) {
      throw new Meteor.Error(403, "Access denied");
    }
  }

  return fsFile.remove();
};

var APhandler = function(collection, download, options) {
  options.httpHeaders = options.httpHeaders || [];

  return function(data) {
    var self = this;
    var query = self.query || {};
    
    var id = self.params.id;
    if (! id) {
      throw new Meteor.Error(400, "Bad Request", "No file ID specified");
    }

    // Get the fsFile
    var file = collection.findOne({_id: '' + id});
    if (! file) {
      throw new Meteor.Error(404, "Not Found", "There is no file with ID " + id);
    }

    // If HTTP GET then return file
    if (self.method.toLowerCase() === 'get') {
      var copyInfo, filename;

      var copyName = self.params.selector;
      if (typeof copyName !== "string") {
        copyName = "_master";
      }

      copyInfo = file.copies[copyName];
      if (! copyInfo) {
        throw new Meteor.Error(404, "Not Found", "Invalid selector: " + copyName);
      }
      
      filename = copyInfo.name;
      if (typeof copyInfo.type === "string") {
        self.setContentType(copyInfo.type);
      }

      // Add 'Content-Disposition' header if requested a download/attachment URL
      download && self.addHeader(
              'Content-Disposition',
              'attachment; filename="' + filename + '"'
              );

      // Add any other custom headers
      _.each(options.httpHeaders, function(header) {
        self.addHeader(header[0], header[1]);
      });

      self.setStatusCode(200);
      return APDownload.call(self, file, copyName, query.start, query.end);
    }

    // If HTTP PUT then put the data for the file
    else if (self.method.toLowerCase() === 'put') {
      return APUpload.call(self, file, data);
    }

    // If HTTP DEL then delete the file
    else if (self.method.toLowerCase() === 'del') {
      return APDelete.call(self, file);
    }
  };
};

accessPointsDDP = function(cfs, options) {
  var result = {};
  // We namespace with using the current Meteor convention - this could
  // change
  result[cfs.methodName + '/put'] = APUpload;
  result[cfs.methodName + '/get'] = APDownload;
  result[cfs.methodName + '/del'] = APDelete;
  return result;
};

accessPointsHTTP = function(cfs, options) {
  var result = {};
  // We namespace with using the current Meteor convention - this could
  // change
  result[cfs.httpUrl + '/download/:id'] = APhandler(cfs, true, options);
  result[cfs.httpUrl + '/download/:id/:selector'] = APhandler(cfs, true, options);
  result[cfs.httpUrl + '/:id'] = APhandler(cfs, false, options);
  result[cfs.httpUrl + '/:id/:selector'] = APhandler(cfs, false, options);
  return result;
};