const SAFE_REPOSITORY_PATH = /^(?!\/)(?!.*\\)(?!.*\0)(?!.*(?:^|\/)\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Relative, slash-separated, ASCII-only path with no `.`/`..` segments, backslashes or NULs. */
export function isSafeRepositoryPath(path: string): boolean {
  return SAFE_REPOSITORY_PATH.test(path) && !path.split("/").some((part) => part === "." || part === "..");
}
