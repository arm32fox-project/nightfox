/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/*
 * Migrates from a Basilisk profile in a lossy manner in order to clean up a
 * user's profile.  Data is only migrated where the benefits outweigh the
 * potential problems caused by importing undesired/invalid configurations
 * from the source profile.
 */

const { classes: Cc, interfaces: Ci, utils: Cu } = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource:///modules/MigrationUtils.jsm"); /* globals MigratorPrototype */
Cu.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "PlacesBackups",
                                  "resource://gre/modules/PlacesBackups.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "SessionMigration",
                                  "resource:///modules/sessionstore/SessionMigration.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "OS",
                                  "resource://gre/modules/osfile.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "FileUtils",
                                  "resource://gre/modules/FileUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "ProfileAge",
                                  "resource://gre/modules/ProfileAge.jsm");


function FirefoxProfileMigrator() {
  this.wrappedJSObject = this; // for testing...
}

FirefoxProfileMigrator.prototype = Object.create(MigratorPrototype);

FirefoxProfileMigrator.prototype._getAllProfiles = function() {
  let allProfiles = new Map();
  let profiles =
    Components.classes["@mozilla.org/toolkit/profile-service;1"]
              .getService(Components.interfaces.nsIToolkitProfileService)
              .profiles;
  while (profiles.hasMoreElements()) {
    let profile = profiles.getNext().QueryInterface(Ci.nsIToolkitProfile);
    let rootDir = profile.rootDir;

    if (rootDir.exists() && rootDir.isReadable() &&
        !rootDir.equals(MigrationUtils.profileStartup.directory)) {
      allProfiles.set(profile.name, rootDir);
    }
  }
  return allProfiles;
};

function sorter(a, b) {
  return a.id.toLocaleLowerCase().localeCompare(b.id.toLocaleLowerCase());
}

Object.defineProperty(FirefoxProfileMigrator.prototype, "sourceProfiles", {
  get: function() {
    return [...this._getAllProfiles().keys()].map(x => ({id: x, name: x})).sort(sorter);
  }
});

FirefoxProfileMigrator.prototype._getFileObject = function(dir, fileName) {
  let file = dir.clone();
  file.append(fileName);

  // File resources are monolithic.  We don't make partial copies since
  // they are not expected to work alone. Return null to avoid trying to
  // copy non-existing files.
  return file.exists() ? file : null;
};

FirefoxProfileMigrator.prototype.getResources = function(aProfile) {
  let sourceProfileDir = aProfile ? this._getAllProfiles().get(aProfile.id) :
    Components.classes["@mozilla.org/toolkit/profile-service;1"]
              .getService(Components.interfaces.nsIToolkitProfileService)
              .selectedProfile.rootDir;
  if (!sourceProfileDir || !sourceProfileDir.exists() ||
      !sourceProfileDir.isReadable())
    return null;

  // Being a startup-only migrator, we can rely on
  // MigrationUtils.profileStartup being set.
  let currentProfileDir = MigrationUtils.profileStartup.directory;

  // Surely data cannot be imported from the current profile.
  if (sourceProfileDir.equals(currentProfileDir))
    return null;

  return this._getResourcesInternal(sourceProfileDir, currentProfileDir);
};

FirefoxProfileMigrator.prototype.getLastUsedDate = function() {
  // We always pretend we're really old, so that we don't mess
  // up the determination of which browser is the most 'recent'
  // to import from.
  return Promise.resolve(new Date(0));
};

FirefoxProfileMigrator.prototype._getResourcesInternal = function(sourceProfileDir, currentProfileDir) {
  let getFileResource = function(aMigrationType, aFileNames) {
    let files = [];
    for (let fileName of aFileNames) {
      let file = this._getFileObject(sourceProfileDir, fileName);
      if (file)
        files.push(file);
    }
    if (!files.length) {
      return null;
    }
    return {
      type: aMigrationType,
      migrate: function(aCallback) {
        for (let file of files) {
          file.copyTo(currentProfileDir, "");
        }
        aCallback(true);
      }
    };
  }.bind(this);

  let types = MigrationUtils.resourceTypes;
  let places = getFileResource(types.HISTORY, ["places.sqlite", "places.sqlite-wal"]);
  let cookies = getFileResource(types.COOKIES, ["cookies.sqlite", "cookies.sqlite-wal"]);
  let passwords = getFileResource(types.PASSWORDS,
                                  ["signons.sqlite", "logins.json", "key3.db",
                                   "signedInUser.json"]);
  let formData = getFileResource(types.FORMDATA, ["formhistory.sqlite"]);
  let bookmarksBackups = getFileResource(types.OTHERDATA,
    [PlacesBackups.profileRelativeFolderPath]);
  let dictionary = getFileResource(types.OTHERDATA, ["persdict.dat"]);

  let sessionCheckpoints = this._getFileObject(sourceProfileDir, "sessionCheckpoints.json");
  let sessionFile = this._getFileObject(sourceProfileDir, "sessionstore.js");
  let session;
  if (sessionFile) {
    session = {
      type: types.SESSION,
      migrate: function(aCallback) {
        sessionCheckpoints.copyTo(currentProfileDir, "sessionCheckpoints.json");
        let newSessionFile = currentProfileDir.clone();
        newSessionFile.append("sessionstore.js");
        let migrationPromise = SessionMigration.migrate(sessionFile.path, newSessionFile.path);
        migrationPromise.then(function() {
          let buildID = Services.appinfo.platformBuildID;
          let mstone = Services.appinfo.platformVersion;
          // Force the browser to one-off resume the session that we give it:
          Services.prefs.setBoolPref("browser.sessionstore.resume_session_once", true);
          // Reset the homepage_override prefs so that the browser doesn't override our
          // session with the "what's new" page:
          Services.prefs.setCharPref("browser.startup.homepage_override.mstone", mstone);
          Services.prefs.setCharPref("browser.startup.homepage_override.buildID", buildID);
          // It's too early in startup for the pref service to have a profile directory,
          // so we have to manually tell it where to save the prefs file.
          let newPrefsFile = currentProfileDir.clone();
          newPrefsFile.append("prefs.js");
          Services.prefs.savePrefFile(newPrefsFile);
          aCallback(true);
        }, function() {
          aCallback(false);
        });
      }
    };
  }

  return [places, cookies, passwords, formData, dictionary, bookmarksBackups,
          session].filter(r => r);
};

Object.defineProperty(FirefoxProfileMigrator.prototype, "startupOnlyMigrator", {
  get: () => true
});


FirefoxProfileMigrator.prototype.classDescription = "Firefox Profile Migrator";
FirefoxProfileMigrator.prototype.contractID = "@mozilla.org/profile/migrator;1?app=browser&type=firefox";
FirefoxProfileMigrator.prototype.classID = Components.ID("{91185366-ba97-4438-acba-48deaca63386}");

this.NSGetFactory = XPCOMUtils.generateNSGetFactory([FirefoxProfileMigrator]);
