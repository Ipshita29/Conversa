// Brand marks drawn as inline SVG (lucide-react ships no brand logos, and no icon package with them is installed).
export function WhatsAppLogo({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="WhatsApp">
      <circle cx="24" cy="24" r="24" fill="#25D366" />
      <path fill="#fff" d="M24.1 10.5a13.3 13.3 0 0 0-11.4 20.1l-1.9 6.9 7.1-1.9A13.3 13.3 0 1 0 24.1 10.5Zm0 2.4a10.9 10.9 0 1 1-5.6 20.3l-.5-.3-4.2 1.1 1.1-4.1-.3-.5A10.9 10.9 0 0 1 24.1 12.9Z" />
      <path fill="#fff" d="M19.2 17.8c-.3-.7-.6-.7-.9-.7h-.7c-.3 0-.7.1-1.1.5-.4.4-1.400 1.400-1.400 3.400s1.500 3.900 1.700 4.200c.2.300 2.900 4.600 7.100 6.200 3.500 1.400 4.200 1.100 4.900 1 .8-.1 2.500-1 2.800-2 .4-1 .4-1.800.2-2-.1-.2-.4-.3-.8-.5l-2.700-1.300c-.4-.1-.6-.2-.9.200l-1.200 1.500c-.2.300-.5.300-.9.100-.4-.2-1.700-.6-3.200-2-1.200-1.100-2-2.400-2.200-2.800-.2-.4 0-.6.200-.8l.6-.7c.2-.2.300-.4.400-.7.100-.3.100-.5 0-.7l-1.200-3Z" />
    </svg>
  );
}

export function InstagramLogo({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Instagram">
      <defs>
        <radialGradient id="ig-grad" cx="0.3" cy="1.05" r="1.25">
          <stop offset="0" stopColor="#FFD879" />
          <stop offset="0.25" stopColor="#F9A03A" />
          <stop offset="0.5" stopColor="#E1306C" />
          <stop offset="0.8" stopColor="#A133B8" />
          <stop offset="1" stopColor="#5851DB" />
        </radialGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#ig-grad)" />
      <rect x="12.5" y="12.5" width="23" height="23" rx="7" fill="none" stroke="#fff" strokeWidth="2.6" />
      <circle cx="24" cy="24" r="5.6" fill="none" stroke="#fff" strokeWidth="2.6" />
      <circle cx="30.8" cy="17.2" r="1.7" fill="#fff" />
    </svg>
  );
}
