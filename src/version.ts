/**
 * The release a build carries, shown beside the logotype so a reader can say which version
 * drew what they are looking at. The major alone: that is what changes the shape of a
 * record, and a patch never changes what the dialog says.
 *
 * Held in step with package.json by a test rather than by a build step, so the published
 * output stays what tsc emitted and nothing has to be substituted into it.
 */
export const version = 'v0';
