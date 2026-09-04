import type { Metadata } from "next";
import MediaReviewApp from "./MediaReviewApp";

export const metadata: Metadata = {
  title: "メディア仕分け",
  description: "画像と動画を端末内だけで、いる・いらないに仕分けます。",
};

export default function Home() {
  return <MediaReviewApp />;
}
