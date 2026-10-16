import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFolder } from "./files.ts";

/** Private folders for the members of one run: each member works in its own copy of the folder. */
export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(): Promise<Workspace> {
    return new Workspace(await mkdtemp(join(tmpdir(), "acp-jury-")));
  }

  /** A member's private folder, with a fresh copy of the material in `folder/`. */
  async seat(label: string, folder: string): Promise<{ scratchDir: string; workDir: string }> {
    const scratchDir = join(this.root, label.replace("member:", ""));
    const workDir = join(scratchDir, "folder");
    await mkdir(scratchDir, { recursive: true });
    await copyFolder(folder, workDir);
    return { scratchDir, workDir };
  }

  async remove(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
