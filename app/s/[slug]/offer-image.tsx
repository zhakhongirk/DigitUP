import Image from "next/image";

type Props = {
  src: string;
  alt: string;
  className: string;
  size: number;
  sizes: string;
  priority?: boolean;
};

export function OfferImage({ src, alt, className, size, sizes, priority }: Props) {
  const local = src.startsWith("/") && !src.startsWith("//");
  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      sizes={sizes}
      className={className}
      priority={priority}
      unoptimized={!local || src.endsWith(".svg")}
    />
  );
}
