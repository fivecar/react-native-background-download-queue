# react-native-background-downloader-queue

[![npm package][npm-img]][npm-url]
[![Build Status][build-img]][build-url]
[![Downloads][downloads-img]][downloads-url]
[![Issues][issues-img]][issues-url]
[![Code Coverage][codecov-img]][codecov-url]
[![Commitizen Friendly][commitizen-img]][commitizen-url]
[![Semantic Release][semantic-release-img]][semantic-release-url]

Automatically download files from urls, even in the background, and keep them locally cached with no headache or babysitting. Robustly retries until successful. Supports wifi-only downloads as well.
* Enhances `downloadFile` from `react-native-fs` by supporting background downloads on iOS (i.e. downloads will continue even if you close your app) by using `react-native-background-downloader`.
* Automatically resumes suspended downloads when you next launch your app.
* Automatically retries failed downloads until they succeed. This happens even if you restart your app, until it's ultimately successful.
* Reconciles all your cached/downloaded files with a set of URLs you can change at any time. This way, you can just manage the list of URLs you want at any time, and everything else is taken care of for you.
* Supports lazy deletion.
* Supports easy implementation of wifi-only downloads if desired.
* Automation-tested with 100% code coverage.

## Install

First install peer dependencies:
* [react-native-background-downloader](https://github.com/kesha-antonov/react-native-background-downloader#readme)
* [react-native-fs](https://github.com/itinance/react-native-fs#readme)
* [@react-native-async-storage/async-storage](https://github.com/react-native-async-storage/async-storage#readme)

Once those are done, install this package:

```bash
npm install react-native-background-downloader-queue
```
or
```bash
yarn add react-native-background-downloader-queue
```

## Example

```Typescript
import DownloadQueue from "react-native-background-downloader-queue";

new DownloadQueue({
  onBegin: (url, bytes) => console.log("Download started", url, bytes),
  onDone: url => console.log("Download finished", url),
  onError: (url, error) => console.log("Download error", url, error),
  onProgress: (url, fraction, bytes, totalBytes) => console.log("Download progress", url, fraction, bytes, totalBytes)
);

await downloader.init();
await downloader.addUrl("https://example.com/boo.mp3");

...
// This path will either be a local path if the file has been 
// downloaded. If not, you'll get the remote url.
const localOrRemotePath = await downloader.getAvailableUrl("https://example.com/boo.mp3");

// ... use localOrRemotePath in <Image> or a media playing API
```

## API

For full documentation, see the javaDoc style comments in the package which automatically come up in VS Code when you use this library.

### `async init(options?: DownloadQueueOptions): Promise<void>`

Gets everything started (e.g. reconstitutes state from storage and reconciles it with downloads that might have completed in the background, subscribes to events, etc). You must call this first.

You can pass any of the following options, or nothing at all:

| Option | Type | Default | Description |
|---|---|---|---|
|handlers|DownloadQueueHandlers|undefined|For any events you'd like to receive notifications about, you'll need to pass a handler here. More details in the next table.|
|domain|string|"main"|By default, AsyncStorage keys and RNFS filenames are with DownloadQueue/main". If you want to use something other than "main", pass it here. This is commonly used to manage different queues for different users (e.g. you can use userId as the domain).|
|startActive|boolean|true|Whether to start the queue in an active state where downloads will be started. If false, no downloads will begin until you call resumeAll().|
|netInfoAddEventListener|(listener: (state: {isConnected: boolean \| null, type: string}) => void) => ()=> void|undefined|If you'd like DownloadQueue to pause downloads when the device is offline, pass this. Usually easiest to literally pass `NetInfo.addEventListener`.|
|activeNetworkTypes| string[] | [] |The NetInfoStateType values for which downloads will be allowed. If you pass undefined or [], downloads will happen on all connection types. A common practice is to pass ["wifi", "ethernet"] if you want to help users avoid cellular data charges. As of @react-native-community/netinfo@9.3.7, valid values are "unknown", "none", "wifi", "cellular", "bluetooth", "ethernet", "wimax", "vpn", "other", "mixed".|

Here are the optional notification handlers you can pass to be informed of download status changes:

| Handler | Description |
|---|---|
|`onBegin?: (url: string, totalBytes: number) => void` | Called when the download has begun and the total number of bytes expected is known.|
|`onProgress?: (url: string, fractionWritten: number, bytesWritten: number, totalBytes: number) => void` | Called at most every 1.5 seconds for any file while it's downloading. `fractionWritten` is between 0.0 and 1.0|
|`onDone?: (url: string) => void`| Called when the download has completed successfully.|
|`onWillRemove?: (url: string) => Promise<void>`| Called before any url is removed from the queue. This is async because `removeUrl` (and also `setQueue`, when it needs to remove some urls) will block until you return from this, giving you the opportunity remove any dependencies on any downloaded local file before it's deleted.|
|`onError?: (url: string, error: any) => void`| Called when there's been an issue downloading the file. Note that this is mostly for you to communicate something to the user, or to do other housekeeping; DownloadQueue will automatically re-attempt the download every minute (while you're online) until it succeeds.|

### `terminate(): void`

Terminates all pending downloads and stops all activity, including
processing lazy-deletes. You can re-init() if you'd like -- but in most cases where you plan to re-init, `pause()` might be what you really meant.

### `async addUrl(url: string): Promise<void>`

Downloads a url to the local documents directory. Safe to call if it's already been added before. If it's been lazy-deleted, it'll be revived.

### `async removeUrl(url: string, deleteTime = -1): Promise<void>`

Removes a url record and any associated file that's been downloaded. Can optionally be a lazy delete if you pass a `deleteTime` timestamp.

### `async setQueue(urls: string[], deleteTime = -1): Promise<void>`

Sets the sum total of urls to keep in the queue. If previously-added urls don't show up here, they'll be removed. New urls will be added.

### `async getQueueStatus(): Promise<DownloadQueueStatus[]>`

Returns the status of all urls in the queue, excluding urls marked for lazy deletion.

| Field | Type | Description  |
|---|---|---|
| url | string  | Original url given for the download |
| path  | string  | Path to local file |
| complete | boolean | Whether the file is completely downloaded. Note that if this is `false`, `path` may point to a file that either doesn't exist, or that is only partially downloaded. |

### `pauseAll(): void`

Pauses all active downloads. Most used to implement wifi-only downloads, by pausing when NetInfo reports a non-wifi connection.

### `resumeAll(): void`

Resumes all active downloads that were previously paused. If you `init()` with `startActive === false`, you'll want to call this at some point or else downloads will never happen. Also, downloads will only proceed if the network connection type passes the `activeNetworkTypes` filter (which by default allows all connection types).

### `async getAvailableUrl(url: string): Promise<string>`

Gets a remote or local url, preferring to the local path when possible. If the local file hasn't yet been downloaded, returns the remote url.


[build-img]:https://github.com/fivecar/react-native-background-downloader-queue/actions/workflows/release.yml/badge.svg
[build-url]:https://github.com/fivecar/react-native-background-downloader-queue/actions/workflows/release.yml
[downloads-img]:https://img.shields.io/npm/dt/react-native-background-downloader-queue
[downloads-url]:https://www.npmtrends.com/react-native-background-downloader-queue
[npm-img]:https://img.shields.io/npm/v/react-native-background-downloader-queue
[npm-url]:https://www.npmjs.com/package/react-native-background-downloader-queue
[issues-img]:https://img.shields.io/github/issues/fivecar/react-native-background-downloader-queue
[issues-url]:https://github.com/fivecar/react-native-background-downloader-queue/issues
[codecov-img]:https://codecov.io/gh/fivecar/react-native-background-downloader-queue/branch/main/graph/badge.svg
[codecov-url]:https://codecov.io/gh/fivecar/react-native-background-downloader-queue
[semantic-release-img]:https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg
[semantic-release-url]:https://github.com/semantic-release/semantic-release
[commitizen-img]:https://img.shields.io/badge/commitizen-friendly-brightgreen.svg
[commitizen-url]:http://commitizen.github.io/cz-cli/
