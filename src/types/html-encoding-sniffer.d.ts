declare module 'html-encoding-sniffer' {
  /** The canonical name of the encoding a browser would decode these bytes with. */
  export default function htmlEncodingSniffer(
    bytes: Uint8Array,
    options?: {
      xml?: boolean;
      transportLayerEncodingLabel?: string;
      defaultEncoding?: string;
      maxPrescanBytes?: number;
    },
  ): string;
}
