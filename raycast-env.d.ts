/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `search-files` command */
  export type SearchFiles = ExtensionPreferences & {
  /** Include Hidden Files - When enabled, fd scans hidden files too (configs, dotfiles). */
  "includeHidden": boolean,
  /** Include Ignored Files - When enabled, files excluded by .gitignore are indexed too. Larger index. */
  "includeIgnored": boolean,
  /** Extra Excludes - Comma-separated fd exclude patterns on top of the built-in defaults. */
  "extraExcludes": string,
  /** Custom Search Paths - Comma-separated absolute directories for the Custom scope. */
  "customSearchPaths": string,
  /** Index Max Age (min) - Index older than this is rebuilt in the background on open. */
  "indexMaxAgeMinutes": string,
  /** Result Limit - Maximum number of results rendered. */
  "resultLimit": string
}
}

declare namespace Arguments {
  /** Arguments passed to the `search-files` command */
  export type SearchFiles = {}
}

