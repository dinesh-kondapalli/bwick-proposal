import Link from "next/link";
import Image from "next/image";

export function FrenzyLogo() {
  return (
    <Link href="/" aria-label="BWICK home" className="inline-flex items-center">
      <span className="relative block h-[42px] w-[132px] overflow-hidden">
        <Image
          src="/signal-2026-05-14-115530_002.jpeg"
          alt="BWICK"
          fill
          className="object-cover object-center scale-[1.35]"
          priority
        />
      </span>
    </Link>
  );
}
