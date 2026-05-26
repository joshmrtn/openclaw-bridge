import importlib.util
import os

def test_queue_manager_importable():
    p = os.path.join(os.path.dirname(__file__), '..', 'lib', 'queue_manager.py')
    assert os.path.exists(p), f'{p} should exist'
    spec = importlib.util.spec_from_file_location('queue_manager', p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod is not None
