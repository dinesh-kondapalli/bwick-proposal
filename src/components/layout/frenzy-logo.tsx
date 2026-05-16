import Link from "next/link";
import Image from "next/image";

export function FrenzyLogo() {
  return (
    <Link href="/" aria-label="BWICK home" className="inline-flex items-center">
      <span className="relative block h-8 w-8 overflow-hidden rounded-[9px] shadow-[0_2px_8px_rgba(255,116,72,0.28)]">
        <Image
          src="/bwick-icon-32.19b13da7.png"
          alt="BWICK"
          width={32}
          height={32}
          className="h-full w-full object-cover"
          priority
        />
      </span>
    </Link>
  );
}
