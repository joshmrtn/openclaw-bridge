import importlib.util
import os

def test_st_client_importable():
    p = os.path.join(os.path.dirname(__file__), '..', 'lib', 'st_client.py')
    assert os.path.exists(p), f'{p} should exist'
    spec = importlib.util.spec_from_file_location('st_client', p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod is not None
