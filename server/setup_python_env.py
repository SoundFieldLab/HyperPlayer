"""
Python environment setup script for WaveForge analysis worker
"""

import sys
import subprocess
import os
from pathlib import Path


def check_package(package_name, import_name=None):
    """Check if a package is installed"""
    if import_name is None:
        import_name = package_name
    
    try:
        __import__(import_name)
        return True
    except ImportError:
        return False


def install_packages():
    """Install required packages"""
    packages = [
        'beat-this',
        'librosa',
        'numpy',
        'soundfile',
        'pedalboard'
    ]
    
    print("Installing required packages...")
    for package in packages:
        print(f"  Installing {package}...")
        try:
            subprocess.check_call([
                sys.executable, '-m', 'pip', 'install', package,
                '--quiet', '--disable-pip-version-check'
            ])
        except subprocess.CalledProcessError as e:
            print(f"  WARNING: Failed to install {package}: {e}")
    
    print("Package installation complete")


def verify_environment():
    """Verify the environment is properly set up"""
    print("\nVerifying environment...")
    
    checks = [
        ('numpy', 'numpy'),
        ('beat-this', 'beat_this'),
        ('librosa', 'librosa'),
        ('soundfile', 'soundfile'),
        ('pedalboard', 'pedalboard')
    ]
    
    all_ok = True
    for package, import_name in checks:
        installed = check_package(package, import_name)
        status = "✓" if installed else "✗"
        print(f"  {status} {package}")
        if not installed:
            all_ok = False
    
    return all_ok


def download_beat_this_model():
    """Download Beat This model if not already cached"""
    print("\nChecking Beat This model...")
    try:
        # This will trigger model download if needed
        from beat_this.inference import load_model
        model = load_model('final0', device='cpu')
        print("  ✓ Beat This model ready")
        return True
    except Exception as e:
        print(f"  ✗ Failed to load model: {e}")
        return False


if __name__ == '__main__':
    print("WaveForge Analysis Environment Setup")
    print("=" * 50)
    
    # Install packages
    install_packages()
    
    # Verify
    if verify_environment():
        print("\n✓ Environment setup complete!")
        
        # Download model
        download_beat_this_model()
        
        print("\nYou can now run the analysis worker.")
    else:
        print("\n✗ Environment setup incomplete. Please install missing packages manually.")
        sys.exit(1)
