import { useEffect, useLayoutEffect, useRef } from 'react';

// Keeps a chat scrolled to its newest message, the way a messaging app does:
//  - opening a conversation (or refreshing the page) lands on the latest message;
//  - while the reader is at (or near) the bottom, anything that makes the content taller keeps the bottom in view: a new message, and also a picture
//    finishing loading or a card laying out, which is why this watches the content's size instead of counting messages or guessing a delay;
//  - a reader who has scrolled up to read older messages is never pulled back down.
// `key` identifies the open conversation; `flowRef` is the element that wraps the messages.
const NEAR = 80; // px from the bottom that still counts as "at the bottom"

export default function useStickyScroll(scrollRef, flowRef, key) {
  const stick = useRef(true);
  const toBottom = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight - el.clientHeight; };

  // A different conversation: stick to its bottom again, before the browser paints.
  useLayoutEffect(() => { stick.current = true; toBottom(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollRef.current; const flow = flowRef.current;
    if (!el || !flow) return undefined;
    // A scroll event also fires when the browser clamps the position because the content or the chat area changed size. That is not the reader moving,
    // so only a scroll that happened with the same sizes counts as the reader's own, and only that can change whether we follow the bottom.
    let seen = { h: el.scrollHeight, c: el.clientHeight };
    const onScroll = () => {
      const resized = el.scrollHeight !== seen.h || el.clientHeight !== seen.c;
      seen = { h: el.scrollHeight, c: el.clientHeight };
      if (!resized) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // Content grew or shrank (new message, picture loaded, payment card, draft form) or the chat area itself was resized (window, suggestions).
    const ro = new ResizeObserver(() => { if (stick.current) toBottom(); seen = { h: el.scrollHeight, c: el.clientHeight }; });
    ro.observe(flow); ro.observe(el);
    // Pictures start with no height and report it when they load; the observer above sees the resulting growth, and this catches the load itself.
    const onLoad = () => { if (stick.current) toBottom(); };
    el.addEventListener('load', onLoad, true);
    return () => { el.removeEventListener('scroll', onScroll); el.removeEventListener('load', onLoad, true); ro.disconnect(); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
