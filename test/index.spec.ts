import AsyncStorage from "@react-native-async-storage/async-storage";
import { mock } from "jest-mock-extended";
import KVFS from "key-value-file-system";
import {
  BeginHandler,
  checkForExistingDownloads,
  DoneHandler,
  download,
  DownloadTask,
  ErrorHandler,
  ProgressHandler,
} from "react-native-background-downloader";
import RNFS, { exists, readdir, unlink } from "react-native-fs";
import DownloadQueue, { DownloadQueueHandlers } from "../src";

jest.mock("@react-native-async-storage/async-storage", () => {
  const store: { [key: string]: string } = {};
  return {
    getItem: jest.fn((key: string) => Promise.resolve(store[key])),
    getAllKeys: jest.fn(() => Promise.resolve(Object.keys(store))),
    multiGet: jest.fn((keys: string[]) =>
      Promise.resolve(keys.map(key => [key, store[key]]))
    ),
    setItem: jest.fn((key: string, value: string) => {
      store[key] = value;
    }),
    multiSet: jest.fn((keyValuePairs: string[][]) => {
      keyValuePairs.forEach(([key, value]) => (store[key] = value));
    }),
    multiRemove: jest.fn((keys: string[]) => {
      keys.forEach(key => delete store[key]);
    }),
  };
});

// Not sure why putting this in /__mocks__ doesn't work, when things like
// react-native-fs do. Spent too long researching it.
jest.mock("react-native-background-downloader", () => ({
  checkForExistingDownloads: jest.fn(() => []),
  download: jest.fn(() => ({})),
  completeHandler: jest.fn(),
}));

jest.mock("react-native-fs", () => {
  return {
    mkdir: jest.fn(),
    moveFile: jest.fn(),
    copyFile: jest.fn(),
    pathForBundle: jest.fn(),
    pathForGroup: jest.fn(),
    getFSInfo: jest.fn(),
    getAllExternalFilesDirs: jest.fn(),
    unlink: jest.fn(),
    exists: jest.fn(),
    stopDownload: jest.fn(),
    resumeDownload: jest.fn(),
    isResumable: jest.fn(),
    stopUpload: jest.fn(),
    completeHandlerIOS: jest.fn(),
    readDir: jest.fn(),
    readDirAssets: jest.fn(),
    existsAssets: jest.fn(),
    readdir: jest.fn(() => []),
    setReadable: jest.fn(),
    stat: jest.fn(),
    readFile: jest.fn(),
    read: jest.fn(),
    readFileAssets: jest.fn(),
    hash: jest.fn(),
    copyFileAssets: jest.fn(),
    copyFileAssetsIOS: jest.fn(),
    copyAssetsVideoIOS: jest.fn(),
    writeFile: jest.fn(),
    appendFile: jest.fn(),
    write: jest.fn(),
    downloadFile: jest.fn(),
    uploadFiles: jest.fn(),
    touch: jest.fn(),
    MainBundlePath: jest.fn(),
    CachesDirectoryPath: jest.fn(),
    DocumentDirectoryPath: "/usr/fake/myDocs",
    ExternalDirectoryPath: jest.fn(),
    ExternalStorageDirectoryPath: jest.fn(),
    TemporaryDirectoryPath: jest.fn(),
    LibraryDirectoryPath: jest.fn(),
    PicturesDirectoryPath: jest.fn(),
    RNFSFileTypeRegular: jest.fn(),
  };
});

jest.useFakeTimers();
jest.spyOn(global, "setTimeout");

const kvfs = new KVFS(AsyncStorage, "DownloadQueue");

// When jest advances fake timers, the async pending queue isn't flushed. Thus
// your expects will run before the async code that's executed by any timer
// actually finishes. Await this function to ensure that all async code fired
// by timers actually is flushed.
// https://github.com/facebook/jest/issues/2157#issuecomment-1272503136
async function advanceThroughNextTimersAndPromises() {
  jest.advanceTimersToNextTimer();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  await new Promise(jest.requireActual("timers").setImmediate);
}

describe("DownloadQueue", () => {
  afterEach(async () => {
    await kvfs.rmAllForce();
    jest.clearAllMocks();
  });

  describe("Initialization", () => {
    it("should throw when uninitialized", async () => {
      const queue = new DownloadQueue();

      await expect(queue.addUrl("whatevs")).rejects.toThrow();
      await expect(queue.removeUrl("whatevs")).rejects.toThrow();
      await expect(queue.setQueue([])).rejects.toThrow();
      expect(() => queue.pauseAll()).toThrow();
      expect(() => queue.resumeAll()).toThrow();
      await expect(queue.getAvailableUrl("whatevs")).rejects.toThrow();
    });

    it("initializes when nothing's going on", async () => {
      const queue = new DownloadQueue();

      await expect(queue.init()).resolves.not.toThrow();
    });

    it("doesn't double-initialize", async () => {
      const queue = new DownloadQueue();

      await queue.init();
      await expect(queue.init()).rejects.toThrow();
    });

    it("initializes ok without download dir", async () => {
      // The first time a user runs, readdir will throw because our download
      // directory hasn't been created. We should handle that.
      (readdir as jest.Mock).mockImplementationOnce(() => {
        throw new Error("dir not found!");
      });

      const queue = new DownloadQueue();

      await expect(queue.init()).resolves.not.toThrow();
    });

    it("deletes files without specs upon init", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");

      (readdir as jest.Mock).mockImplementationOnce(() => ["foo", "bar"]);
      await queue.init();
      expect(unlink).toHaveBeenNthCalledWith(
        1,
        `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`
      );
      expect(unlink).toHaveBeenNthCalledWith(
        2,
        `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/bar`
      );
      expect(unlink).toHaveBeenCalledTimes(2);
    });

    it("doesn't delete files that have specs on init", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");

      (readdir as jest.Mock).mockImplementationOnce(() => ["foo", "bar"]);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init();
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/bar`
        )
      );
      expect(unlink).toHaveBeenCalledTimes(1);
    });

    it("revives specs from previous launches", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const backTask: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => backTask),
        progress: jest.fn(() => backTask),
        done: jest.fn(() => backTask),
        error: jest.fn(() => backTask),
        resume: jest.fn(() => backTask),
      };

      (checkForExistingDownloads as jest.Mock).mockImplementationOnce(
        (): DownloadTask[] => [backTask]
      );

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init();
      expect(backTask.resume).toHaveBeenCalledTimes(1);
    });

    it("stops tasks from previous launches without specs ", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const backTask: DownloadTask = {
        ...baseTask,
        id: "foo",
        stop: jest.fn(() => backTask),
      };

      (checkForExistingDownloads as jest.Mock).mockImplementationOnce(
        (): DownloadTask[] => [backTask]
      );

      await queue.init();
      expect(backTask.stop).toHaveBeenCalledTimes(1);
    });

    it("starts downloads for specs without tasks or files", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
      };

      (download as jest.Mock).mockImplementationOnce(() => task);

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init();
      expect(task.resume).not.toHaveBeenCalled();

      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ id: "foo" })
      );
    });
  });

  describe("Termination", () => {
    it("should stop all active tasks", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const backTask: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => backTask),
        progress: jest.fn(() => backTask),
        done: jest.fn(() => backTask),
        error: jest.fn(() => backTask),
        resume: jest.fn(() => backTask),
        stop: jest.fn(() => backTask),
      };

      (checkForExistingDownloads as jest.Mock).mockImplementationOnce(
        (): DownloadTask[] => [backTask]
      );

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init();
      expect(backTask.resume).toHaveBeenCalled();

      queue.terminate();
      expect(backTask.stop).toHaveBeenCalled();
    });

    it("should restart tasks after terminate/re-init", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const backTask: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => backTask),
        progress: jest.fn(() => backTask),
        done: jest.fn(() => backTask),
        error: jest.fn(() => backTask),
        resume: jest.fn(() => backTask),
        stop: jest.fn(() => backTask),
      };

      (checkForExistingDownloads as jest.Mock).mockImplementation(
        (): DownloadTask[] => [backTask]
      );

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init();
      expect(backTask.resume).toHaveBeenCalled();

      queue.terminate();
      expect(backTask.stop).toHaveBeenCalled();

      await queue.init();
      expect(backTask.resume).toHaveBeenCalledTimes(2);

      (checkForExistingDownloads as jest.Mock).mockClear();
    });
  });

  describe("Adding", () => {
    it("should add a url", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
      };

      (download as jest.Mock).mockImplementationOnce(() => task);

      await queue.init();
      await queue.addUrl("http://foo.com");
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://foo.com" })
      );
    });

    it("shouldn't add the same url twice", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
      };

      (download as jest.Mock).mockImplementationOnce(() => task);

      await queue.init();
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://foo.com");
      expect(download).toHaveBeenCalledTimes(1);
    });

    it("should revive added url upon relaunch", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
      };
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementationOnce((spec: { id: string }) => {
        assignedId = spec.id;
        return task;
      });
      await queue.init();
      await queue.addUrl("http://foo.com");

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      (checkForExistingDownloads as jest.Mock).mockImplementationOnce(
        (): DownloadTask[] => [
          {
            ...task,
            id: assignedId,
          },
        ]
      );

      // Pretend app got launched again by using another queue
      const relaunchQueue = new DownloadQueue(undefined, "mydomain");

      await relaunchQueue.init();
      expect(task.resume).toHaveBeenCalled();
    });

    it("shouldn't re-download revived spec if file already downloaded", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };

      (download as jest.Mock).mockImplementation((spec: { id: string }) => {
        return {
          ...task,
          id: spec.id,
        };
      });
      await queue.init();
      await queue.addUrl("http://foo.com");

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      (exists as jest.Mock).mockImplementationOnce(() => true);

      await queue.removeUrl("http://foo.com", 0);
      await queue.addUrl("http://foo.com");

      expect(download).toHaveBeenCalledTimes(1); // Just the first time only
      (download as jest.Mock).mockClear();
    });

    it("shouldn't re-download revived spec on relaunch if file already downloaded", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation((spec: { id: string }) => {
        assignedId = spec.id;
        return task;
      });
      await queue.init();
      await queue.addUrl("http://foo.com");

      expect(download).toHaveBeenCalledTimes(1);
      expect(task.resume).not.toHaveBeenCalled();

      await queue.removeUrl("http://foo.com");

      (checkForExistingDownloads as jest.Mock).mockImplementationOnce(
        (): DownloadTask[] => [
          {
            ...task,
            id: assignedId,
          },
        ]
      );
      (readdir as jest.Mock).mockImplementationOnce(() => [assignedId]);

      // Pretend app got launched again by using another queue
      const relaunchQueue = new DownloadQueue(undefined, "mydomain");

      await relaunchQueue.init();
      expect(download).toHaveBeenCalledTimes(1); // Just the first time only

      (download as jest.Mock).mockClear();
    });
  });

  describe("Removing", () => {
    it("should remove a url", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementationOnce((spec: { id: string }) => {
        assignedId = spec.id;
        return {
          ...task,
          id: assignedId,
        };
      });

      await queue.init();
      await queue.addUrl("http://foo.com");

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "DownloadQueue/mydomain/" + assignedId,
        expect.anything()
      );

      await queue.removeUrl("http://foo.com");
      expect(unlink).toHaveBeenCalledTimes(1);

      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        "DownloadQueue/mydomain/" + assignedId,
      ]);
    });

    it("should double-remove a url without side effects", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementationOnce((spec: { id: string }) => {
        assignedId = spec.id;
        return {
          ...task,
          id: assignedId,
        };
      });

      await queue.init();
      await queue.addUrl("http://foo.com");

      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "DownloadQueue/mydomain/" + assignedId,
        expect.anything()
      );

      await queue.removeUrl("http://foo.com");
      await queue.removeUrl("http://foo.com");
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(task.stop).toHaveBeenCalledTimes(1);

      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        "DownloadQueue/mydomain/" + assignedId,
      ]);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
    });
  });

  describe("setQueue", () => {
    it("should update a queue with deletion and insertion", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      const idMap: { [key: string]: string } = {};

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }) => {
          idMap[spec.url] = spec.id;
          return {
            ...task,
            id: spec.id,
          };
        }
      );

      await queue.init();
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");
      await queue.addUrl("http://moo.com");

      await queue.setQueue([
        "http://foo.com",
        "http://moo.com",
        "http://shoo.com",
      ]);

      expect(unlink).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        "DownloadQueue/mydomain/" + idMap["http://boo.com"],
      ]);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://shoo.com" })
      );
      expect(download).toHaveBeenCalledTimes(4);

      (download as jest.Mock).mockClear();
    });
  });

  describe("Lazy deletion", () => {
    it("should not immediately delete lazy-deletions", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementationOnce((spec: { id: string }) => {
        assignedId = spec.id;
        return {
          ...task,
          id: assignedId,
        };
      });

      await queue.init();
      await queue.addUrl("http://foo.com");
      await queue.removeUrl("http://foo.com", 0);

      expect(unlink).toHaveBeenCalledTimes(0);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(0);
    });

    it("should delete only next-init lazy deletions during init", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }) => {
          if (spec.url === "http://foo.com") {
            assignedId = spec.id;
          }
          return {
            ...task,
            id: spec.id,
          };
        }
      );

      await queue.init();
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");
      await queue.removeUrl("http://foo.com", 0);
      await queue.removeUrl("http://boo.com", Date.now() + 30000);

      const nextLaunchQueue = new DownloadQueue(undefined, "mydomain");

      await nextLaunchQueue.init();
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        `DownloadQueue/mydomain/${assignedId}`,
      ]);

      jest.runAllTimers(); // Or else the test hangs on boo!
      (download as jest.Mock).mockClear();
    });

    it("should delete lazy deletions on time", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      const urlsToIds: { [url: string]: string } = {
        "http://foo.com": "foo",
        "http://boo.com": "boo",
        "http://moo.com": "moo",
      };

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }) => {
          urlsToIds[spec.url] = spec.id;
          return {
            ...task,
            id: spec.id,
          };
        }
      );

      await queue.init();
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");
      await queue.addUrl("http://moo.com");

      await queue.removeUrl("http://foo.com", 0);
      expect(jest.getTimerCount()).toEqual(0);

      await queue.removeUrl("http://boo.com", Date.now() + 30000);
      await queue.removeUrl("http://moo.com", Date.now() + 180000);

      expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toEqual(2);

      await advanceThroughNextTimersAndPromises();
      expect(jest.getTimerCount()).toEqual(1);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        `DownloadQueue/mydomain/${urlsToIds["http://boo.com"]}`,
      ]);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${urlsToIds["http://boo.com"]}`
        )
      );
      expect(jest.getTimerCount()).toEqual(1);

      await advanceThroughNextTimersAndPromises();
      expect(jest.getTimerCount()).toEqual(0);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(2);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledWith([
        `DownloadQueue/mydomain/${urlsToIds["http://moo.com"]}`,
      ]);
      expect(unlink).toHaveBeenCalledTimes(2);
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(
          `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/${urlsToIds["http://moo.com"]}`
        )
      );

      (download as jest.Mock).mockClear();
    });

    it("should revive re-added lazy-deletions", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      let assignedId = "tbd";

      (download as jest.Mock).mockImplementation((spec: { id: string }) => {
        assignedId = spec.id;
        return {
          ...task,
          id: assignedId,
        };
      });

      await queue.init();
      await queue.addUrl("http://foo.com");

      expect(download).toHaveBeenCalledTimes(1);

      await queue.removeUrl("http://foo.com", 0);

      expect(unlink).toHaveBeenCalledTimes(0);
      expect(AsyncStorage.multiRemove).toHaveBeenCalledTimes(0);

      await queue.addUrl("http://foo.com");
      expect(download).toHaveBeenCalledTimes(2);

      (download as jest.Mock).mockClear();
    });
  });

  describe("Pause / resume", () => {
    it("should start paused if requested", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const backTask: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => backTask),
        progress: jest.fn(() => backTask),
        done: jest.fn(() => backTask),
        error: jest.fn(() => backTask),
        resume: jest.fn(() => backTask),
        pause: jest.fn(() => backTask),
        stop: jest.fn(() => backTask),
      };

      (checkForExistingDownloads as jest.Mock).mockImplementationOnce(
        (): DownloadTask[] => [backTask]
      );

      await kvfs.write("/mydomain/foo", {
        id: "foo",
        url: "http://foo.com",
        path: `${RNFS.DocumentDirectoryPath}/DownloadQueue/mydomain/foo`,
        createTime: Date.now() - 1000,
      });
      await queue.init(false);
      expect(backTask.resume).not.toHaveBeenCalled();
      expect(backTask.pause).toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }) => ({
          ...baseTask,
          id: spec.id,
          begin: jest.fn(() => backTask),
          progress: jest.fn(() => backTask),
          done: jest.fn(() => backTask),
          error: jest.fn(() => backTask),
          pause: jest.fn(() => baseTask),
        })
      );

      await queue.addUrl("http://boo.com");
      expect(backTask.pause).toHaveBeenCalledTimes(1);
    });

    it("should pause/resume everything when asked", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        pause: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      const urlsToIds: { [url: string]: string } = {
        "http://foo.com": "foo",
        "http://boo.com": "boo",
        "http://moo.com": "moo",
      };

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string }) => {
          urlsToIds[spec.url] = spec.id;
          return {
            ...task,
            id: spec.id,
          };
        }
      );

      await queue.init();
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");
      await queue.addUrl("http://moo.com");

      expect(download).toHaveBeenCalledTimes(3);
      expect(task.resume).not.toHaveBeenCalled();
      expect(task.pause).not.toHaveBeenCalled();

      queue.pauseAll();

      expect(download).toHaveBeenCalledTimes(3); // no change expected here
      expect(task.pause).toHaveBeenCalledTimes(3);
      expect(task.resume).not.toHaveBeenCalled();

      queue.resumeAll();

      expect(download).toHaveBeenCalledTimes(3); // no change expected here
      expect(task.pause).toHaveBeenCalledTimes(3); // no change here either
      expect(task.resume).toHaveBeenCalledTimes(3);

      (download as jest.Mock).mockClear();
    });
  });

  describe("Utility functions", () => {
    it("should give you back a url you never added explicitly", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");

      await queue.init();
      const url = await queue.getAvailableUrl("http://foo.com");

      expect(url).toBe("http://foo.com");
    });

    it("should give the right URL depending on download status", async () => {
      const queue = new DownloadQueue(undefined, "mydomain");
      const baseTask = mock<DownloadTask>();
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(() => task),
        progress: jest.fn(() => task),
        done: jest.fn(() => task),
        error: jest.fn(() => task),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };
      let fooPath = "tbd";

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string; destination: string }) => {
          if (spec.url === "http://foo.com") {
            fooPath = spec.destination;
          }
          return {
            ...task,
            id: spec.id,
            path: spec.destination,
          };
        }
      );

      await queue.init();
      await queue.addUrl("http://foo.com");
      await queue.addUrl("http://boo.com");

      // Pretend we've downloaded only foo
      (exists as jest.Mock).mockImplementation(path => path === fooPath);

      const [fooU, booU] = await Promise.all([
        queue.getAvailableUrl("http://foo.com"),
        queue.getAvailableUrl("http://boo.com"),
      ]);

      expect(fooU).toBe(fooPath);
      expect(booU).toBe("http://boo.com");

      (download as jest.Mock).mockClear();
      (exists as jest.Mock).mockClear();
    });

    it("should call handlers for all cases", async () => {
      const handlers: DownloadQueueHandlers = {
        onBegin: jest.fn(),
        onProgress: jest.fn(),
        onDone: jest.fn(),
        onError: jest.fn(),
      };
      const queue = new DownloadQueue(handlers, "mydomain");
      const baseTask = mock<DownloadTask>();
      let beginner: BeginHandler;
      let progresser: ProgressHandler;
      let doner: DoneHandler;
      let errorer: ErrorHandler;
      const task: DownloadTask = {
        ...baseTask,
        id: "foo",
        begin: jest.fn(handler => {
          beginner = handler;
          return task;
        }),
        progress: jest.fn(handler => {
          progresser = handler;
          return task;
        }),
        done: jest.fn(handler => {
          doner = handler;
          return task;
        }),
        error: jest.fn(handler => {
          errorer = handler;
          return task;
        }),
        resume: jest.fn(() => task),
        stop: jest.fn(() => task),
      };

      (download as jest.Mock).mockImplementation(
        (spec: { id: string; url: string; destination: string }) => {
          return {
            ...task,
            id: spec.id,
            path: spec.destination,
          };
        }
      );

      await queue.init();
      await queue.addUrl("http://foo.com");

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      beginner!({ expectedBytes: 300, headers: {} });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      progresser!(0.5, 500, 1000);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      doner!();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      errorer!("foo", 500);

      expect(handlers.onBegin).toHaveBeenCalledTimes(1);
      expect(handlers.onProgress).toHaveBeenCalledTimes(1);
      expect(handlers.onDone).toHaveBeenCalledTimes(1);
      expect(handlers.onError).toHaveBeenCalledTimes(1);
    });
  });
});