/**
 * How many blank line rows the manual builder offers.
 *
 * A fixed grid rather than a JS "add row" widget: the builder is a plain
 * <form> that works without client JavaScript, and eight lines covers every
 * hand-written invoice WACA has ever raised. Empty rows are ignored on submit.
 *
 * Lives in its own module because actions.ts is "use server", where every
 * export must be an async function.
 */
export const LINE_COUNT = 8;
