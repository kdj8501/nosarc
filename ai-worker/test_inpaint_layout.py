import unittest

import numpy as np

from inpaint_layout import text_centered_tiles


class InpaintLayoutTests(unittest.TestCase):
    def assert_covered(self, mask):
        tiles = text_centered_tiles(mask)
        covered = np.zeros_like(mask, dtype=bool)
        for left, top, right, bottom in tiles:
            self.assertGreaterEqual(left, 0)
            self.assertGreaterEqual(top, 0)
            self.assertLessEqual(right, mask.shape[1])
            self.assertLessEqual(bottom, mask.shape[0])
            self.assertLessEqual(right - left, 512)
            self.assertLessEqual(bottom - top, 512)
            covered[top:bottom, left:right] = True
        self.assertTrue(np.all(covered[mask > 0]), "Every masked pixel needs a restoration crop")
        self.assertEqual(len(tiles), len(set(tiles)))
        return tiles

    def test_text_crossing_old_grid_boundary_stays_in_one_crop(self):
        mask = np.zeros((1000, 1200), dtype=np.uint8)
        mask[200:300, 430:510] = 1
        tiles = self.assert_covered(mask)
        self.assertEqual(len(tiles), 1)
        left, top, right, bottom = tiles[0]
        self.assertGreaterEqual(430 - left, 32)
        self.assertGreaterEqual(right - 510, 32)
        self.assertGreaterEqual(200 - top, 32)
        self.assertGreaterEqual(bottom - 300, 32)

    def test_large_and_edge_regions_are_completely_covered(self):
        mask = np.zeros((1400, 1100), dtype=np.uint8)
        mask[100:1200, 200:900] = 1
        mask[:20, :20] = 1
        mask[-20:, -20:] = 1
        self.assert_covered(mask)

    def test_small_page_and_disconnected_glyphs(self):
        mask = np.zeros((80, 100), dtype=np.uint8)
        mask[15:25, 20:25] = 1
        mask[15:25, 30:35] = 1
        self.assertEqual(self.assert_covered(mask), [(0, 0, 100, 80)])

    def test_empty_mask_has_no_inference_tiles(self):
        self.assertEqual(text_centered_tiles(np.zeros((600, 600), dtype=np.uint8)), [])

    def test_sparse_and_dense_masks_have_no_coverage_gaps(self):
        rng = np.random.default_rng(12)
        for height, width in [(513, 513), (1600, 1114), (100, 900), (900, 100)]:
            for density in [.0002, .01, 1.0]:
                mask = (rng.random((height, width)) < density).astype(np.uint8)
                self.assert_covered(mask)


if __name__ == '__main__':
    unittest.main()
