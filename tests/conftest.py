"""pytest configuration — adds the project root to sys.path so that
`src/` is importable as the `src` package (matching its relative imports).
"""
import os
import sys

# Insert the project root so `import src.daemon` etc. resolve correctly
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
