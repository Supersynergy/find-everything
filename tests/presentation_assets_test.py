"""Controller-owned checks for reproducible, offline README artwork."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


class PresentationAssetsTest(unittest.TestCase):
    def test_compositor_uses_native_image_and_outputs_accessible_feature_examples(self):
        source = ROOT / "docs/release/images/native-light.png"
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory(prefix="fe-presentation-art-") as temp:
            output = Path(temp)
            subprocess.run(
                [sys.executable, str(ROOT / "scripts/release/compose-hero.py"), str(source.parent), str(output)],
                check=True, cwd=ROOT, timeout=30,
            )
            hero = output / "hero.png"
            with Image.open(hero) as image:
                self.assertEqual(image.size, (1800, 1320))
                pixels = image.convert("RGB").resize((150, 110)).tobytes()
                self.assertGreater(len({pixels[i:i + 3] for i in range(0, len(pixels), 3)}), 300)
            self.assertGreater(hero.stat().st_size, 80000)
            svg = ET.parse(output / "feature-map.svg").getroot()
            self.assertEqual(svg.attrib.get("viewBox"), "0 0 1800 1274")
            ns = {"s": "http://www.w3.org/2000/svg"}
            self.assertIsNotNone(svg.find("s:title", ns))
            self.assertIsNotNone(svg.find("s:desc", ns))
            self.assertEqual(sum("data-feature" in item.attrib for item in svg.iter()), 7)
            text = " ".join(svg.itertext())
            for expected in ['content:"quarterly revenue"', "Explicit document-text index", "name:invoice", "size:&gt;10m".replace("&gt;", ">"), "duration:&lt;1s".replace("&lt;", "<"), "PDFs größer als 10 MB", "kurze düstere Lasersounds", "MCP", "Optional model setup", "synthetic"]:
                self.assertIn(expected, text)
            self.assertNotIn("OCR", text)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)


if __name__ == "__main__":
    unittest.main()
