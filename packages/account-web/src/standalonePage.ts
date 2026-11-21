/* styles.css sets `overflow: hidden` on body (and fixes body in place on touch
   devices) so the app shell owns scrolling. A page rendered outside the shell
   therefore scrolls itself: its root fills #root and scrolls vertically.
   Content starts at the top; children centre with `my-auto`, which falls back
   to the top when the content is taller than the viewport, so nothing is
   pushed above the scroll origin. */
export const STANDALONE_PAGE = 'flex h-full flex-col overflow-y-auto overscroll-contain bg-background text-foreground antialiased';
