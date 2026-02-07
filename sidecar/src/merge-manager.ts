/**
 * Merge and Diff Operations Module
 *
 * Provides diff generation and merge operations for review workflow.
 * Uses simple-git for all git operations.
 */

import { simpleGit, SimpleGit } from "simple-git";

/**
 * Get unified diff between two branches
 *
 * @param repoPath - Path to git repository
 * @param fromBranch - Source branch (e.g., pool/agent-task-1)
 * @param toBranch - Target branch (e.g., main)
 * @param contextLines - Number of context lines (default 6)
 * @returns Raw unified diff string with --unified=N format
 * @throws Error if diff generation fails
 */
export async function getDiffBetweenBranches(
  repoPath: string,
  fromBranch: string,
  toBranch: string,
  contextLines: number = 6
): Promise<string> {
  const git: SimpleGit = simpleGit(repoPath);

  try {
    console.log(
      `Generating diff: ${toBranch}..${fromBranch} with ${contextLines} context lines`
    );

    // Get unified diff with context lines
    // Format: diff --git a/... b/...
    //         index ...
    //         --- a/...
    //         +++ b/...
    //         @@ -start,count +start,count @@
    //         context line
    //         -removed line
    //         +added line
    const diff = await git.diff([
      `${toBranch}..${fromBranch}`,
      `--unified=${contextLines}`,
      "--function-context", // Show function names in hunk headers
      "--no-ext-diff", // Avoid external diff drivers
    ]);

    console.log(`✓ Generated diff: ${diff.length} bytes`);
    return diff;
  } catch (error) {
    throw new Error(
      `Failed to generate diff for ${fromBranch} vs ${toBranch}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Attempt squash merge of branch to main
 *
 * @param repoPath - Path to git repository
 * @param branchName - Branch to merge
 * @returns Object with success boolean and conflict info
 * @throws Error on fatal git errors (not conflicts)
 */
export async function squashMergeToMain(
  repoPath: string,
  branchName: string
): Promise<{ success: boolean; conflicts: string[] }> {
  const git: SimpleGit = simpleGit(repoPath);

  try {
    console.log(`Attempting squash merge of ${branchName} to main`);

    // Attempt squash merge without committing
    // This allows us to check for conflicts before committing
    const result = await git.merge([branchName, "--squash", "--no-commit"]);

    console.log(`✓ Merge completed`);

    // If merge succeeded, create commit
    const commitMsg = `Merge branch '${branchName}' into main (squash merge)\n\nAll agent commits squashed into single commit.`;
    await git.commit(commitMsg);

    console.log(`✓ Created merge commit`);
    return { success: true, conflicts: [] };
  } catch (error) {
    // Check if merge failed due to conflicts
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Attempt to detect merge conflict
    try {
      // Read merge status (will exist if merge is in progress)
      const status = await git.status();

      if (status.conflicted && status.conflicted.length > 0) {
        console.warn(`Merge conflict detected in files: ${status.conflicted.join(", ")}`);

        // Abort the merge to clean up state
        try {
          await git.merge(["--abort"]);
          console.log(`Merge aborted after conflict detection`);
        } catch (abortErr) {
          console.warn(`Warning: Failed to abort merge: ${abortErr}`);
        }

        return {
          success: false,
          conflicts: status.conflicted,
        };
      }
    } catch (statusErr) {
      console.warn(`Failed to check merge status: ${statusErr}`);
    }

    // Non-conflict merge error
    throw new Error(
      `Failed to merge ${branchName} to main: ${errorMsg}`
    );
  }
}

/**
 * Get list of files changed in diff
 *
 * @param diffString - Raw unified diff string
 * @returns Array of file paths changed
 */
export function extractFilesFromDiff(diffString: string): string[] {
  const files = new Set<string>();
  const lines = diffString.split("\n");

  for (const line of lines) {
    // Match: diff --git a/path b/path
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match && match[2]) {
        files.add(match[2]);
      }
    }
  }

  return Array.from(files);
}

/**
 * Parse unified diff into structured format
 *
 * @param diffString - Raw unified diff string
 * @returns Array of file diffs with hunk information
 */
export function parseDiffString(
  diffString: string
): Array<{
  fileName: string;
  oldFile?: {
    fileName?: string;
    fileLang?: string;
    content?: string;
  };
  newFile?: {
    fileName?: string;
    fileLang?: string;
    content?: string;
  };
  hunks: string[];
}> {
  const files: Array<{
    fileName: string;
    oldFile?: {
      fileName?: string;
      fileLang?: string;
      content?: string;
    };
    newFile?: {
      fileName?: string;
      fileLang?: string;
      content?: string;
    };
    hunks: string[];
  }> = [];

  const lines = diffString.split("\n");

  let currentFile: string | null = null;
  let currentHunks: string[] = [];
  let inHunk = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Start of new file diff
    if (line.startsWith("diff --git")) {
      // Save previous file if exists
      if (currentFile && currentHunks.length > 0) {
        files.push({
          fileName: currentFile,
          newFile: {
            fileName: currentFile,
            fileLang: detectLanguage(currentFile),
            content: "",
          },
          hunks: currentHunks,
        });
      }

      // Parse new file name from "diff --git a/path b/path"
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match && match[2]) {
        currentFile = match[2];
        currentHunks = [];
        inHunk = false;
      }
    }
    // Hunk header line
    else if (line.startsWith("@@")) {
      inHunk = true;
      currentHunks.push(line);
    }
    // Content lines within hunk
    else if (inHunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      currentHunks.push(line);
    }
    // End of hunk (blank line or new section)
    else if (inHunk && line === "") {
      inHunk = false;
    }
  }

  // Save last file
  if (currentFile && currentHunks.length > 0) {
    files.push({
      fileName: currentFile,
      newFile: {
        fileName: currentFile,
        fileLang: detectLanguage(currentFile),
        content: "",
      },
      hunks: currentHunks,
    });
  }

  return files;
}

/**
 * Detect file language based on extension
 */
function detectLanguage(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    cs: "csharp",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    html: "html",
    htm: "html",
    css: "css",
    scss: "css",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sh: "bash",
    bash: "bash",
    sql: "sql",
    xml: "xml",
  };

  return langMap[ext] || "text";
}
