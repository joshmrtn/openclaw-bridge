import importlib.util
import os

def test_registry_importable():
    p = os.path.join(os.path.dirname(__file__), '..', 'lib', 'registry.py')
    assert os.path.exists(p), f'{p} should exist'
    spec = importlib.util.spec_from_file_location('registry', p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # smoke: module loaded
    assert mod is not None
