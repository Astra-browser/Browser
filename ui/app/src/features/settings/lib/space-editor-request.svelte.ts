/**
 * A space the person asked to edit, named across a remount.
 *
 * Creating a space switches to it, and a space switch rebuilds the Settings
 * surface: the page that asked for the editor is gone by the time the space
 * exists. The request survives here instead of in component state, so the
 * editor still opens on the space that was just made.
 */
let pending = $state<string | null>(null);

export const pendingSpaceEditor = () => pending;

export function requestSpaceEditor(id: string | null): void {
  pending = id;
}
