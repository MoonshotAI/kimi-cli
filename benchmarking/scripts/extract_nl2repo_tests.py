#!/usr/bin/env python3
"""
Extract tests from NL2Repo Docker containers.

This script reads the nl2repo dataset, extracts instance IDs,
gets the corresponding Docker images, and copies the /workspace
contents from each container to local storage.
"""

import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List, Dict, Tuple

# Import the image name function from eval_infer.py
NL2REPO_IMAGE_REGISTRY = os.environ.get(
    'NL2REPO_IMAGE_REGISTRY',
    'ghcr.io/multimodal-art-projection/nl2repobench'
)


def get_instance_test_image(instance_id: str) -> str:
    """Get the Docker image name for a given instance ID."""
    project_name = instance_id.lower()
    return f'{NL2REPO_IMAGE_REGISTRY}/{project_name}:1.0'


def read_dataset(dataset_path: str) -> List[Dict]:
    """Read the nl2repo dataset and extract all instances."""
    instances = []
    with open(dataset_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip():
                instance = json.loads(line)
                instances.append(instance)
    return instances


def pull_image(image_name: str) -> bool:
    """Pull a Docker image if not already present."""
    print(f"Checking/pulling image: {image_name}")
    try:
        result = subprocess.run(
            ['docker', 'pull', image_name],
            capture_output=True,
            text=True,
            timeout=300  # 5 minutes timeout
        )
        if result.returncode == 0:
            print(f"✓ Image ready: {image_name}")
            return True
        else:
            print(f"✗ Failed to pull image: {image_name}")
            print(f"Error: {result.stderr}")
            return False
    except subprocess.TimeoutExpired:
        print(f"✗ Timeout pulling image: {image_name}")
        return False
    except Exception as e:
        print(f"✗ Error pulling image: {image_name}: {e}")
        return False


def copy_tests_from_container(instance_id: str, image_name: str, output_dir: Path) -> bool:
    """
    Create a container from the image and copy /workspace contents to local storage.
    
    Args:
        instance_id: The instance identifier
        image_name: The Docker image name
        output_dir: The output directory for this instance
        
    Returns:
        True if successful, False otherwise
    """
    container_name = f"nl2repo_extract_{instance_id}"
    temp_dir = None
    
    try:
        # Create output directory
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Run container in background with a sleep command to keep it alive
        run_result = subprocess.run(
            ['docker', 'run', '-d', '--name', container_name, image_name, 'sleep', '30'],
            capture_output=True,
            text=True,
            timeout=30
        )
        
        if run_result.returncode != 0:
            return False
        
        # Create a temporary directory for copying
        temp_dir = output_dir.parent / f"temp_{instance_id}"
        temp_dir.mkdir(parents=True, exist_ok=True)
        
        # Copy /workspace from container to temp directory
        copy_result = subprocess.run(
            ['docker', 'cp', f'{container_name}:/workspace/.', str(temp_dir)],
            capture_output=True,
            text=True,
            timeout=120
        )
        
        if copy_result.returncode != 0:
            return False
        
        # Move contents from temp to output (avoiding workspcace subdirectory)
        # Check if temp_dir/workspace exists (shouldn't, but just in case)
        workspace_subdir = temp_dir / "workspace"
        if workspace_subdir.exists() and workspace_subdir.is_dir():
            # Move contents from workspace subdirectory to output
            for item in workspace_subdir.iterdir():
                shutil.move(str(item), str(output_dir / item.name))
        else:
            # Move contents directly from temp to output
            for item in temp_dir.iterdir():
                dest = output_dir / item.name
                if dest.exists():
                    if dest.is_dir():
                        shutil.rmtree(dest)
                    else:
                        dest.unlink()
                shutil.move(str(item), str(dest))
        
        return True
        
    except subprocess.TimeoutExpired:
        return False
    except Exception as e:
        return False
    finally:
        # Clean up: stop and remove the container
        try:
            subprocess.run(
                ['docker', 'rm', '-f', container_name],
                capture_output=True,
                timeout=30
            )
        except:
            pass
        
        # Clean up temp directory
        if temp_dir and temp_dir.exists():
            try:
                shutil.rmtree(temp_dir)
            except:
                pass


def process_single_instance(instance: Dict, output_base: Path, index: int, total: int) -> Tuple[str, bool]:
    """
    Process a single instance: pull image and extract tests.
    
    Args:
        instance: The instance data dictionary
        output_base: The base output directory
        index: Current index (1-based)
        total: Total number of instances
        
    Returns:
        Tuple of (instance_id, success)
    """
    instance_id = instance['instance_id']
    
    print(f"\n[{index}/{total}] Processing: {instance_id}")
    print("-" * 80)
    
    # Get image name
    image_name = get_instance_test_image(instance_id)
    print(f"Image: {image_name}")
    
    # Pull image
    if not pull_image(image_name):
        print(f"✗ Failed: {instance_id} (image pull failed)")
        return (instance_id, False)
    
    # Setup output directory
    output_dir = output_base / instance_id
    
    # Copy tests from container
    if copy_tests_from_container(instance_id, image_name, output_dir):
        print(f"✓ Success: {instance_id}")
        return (instance_id, True)
    else:
        print(f"✗ Failed: {instance_id} (extraction failed)")
        return (instance_id, False)


def main():
    """Main execution function."""
    # Setup paths
    dataset_path = Path('/workspace/swe-data/dataset/nl2repo/nl2repo.jsonl')
    output_base = Path('/workspace/swe-data/dataset/nl2repo/tests')
    
    print("=" * 80)
    print("NL2Repo Test Extractor")
    print("=" * 80)
    print(f"Dataset: {dataset_path}")
    print(f"Output: {output_base}")
    print()
    
    # Clean up existing output directory if it exists
    if output_base.exists():
        print(f"Removing existing output directory: {output_base}")
        try:
            shutil.rmtree(output_base)
            print("✓ Cleanup complete")
        except Exception as e:
            print(f"✗ Failed to clean up: {e}")
            return
    print()
    
    # Read dataset
    print("Reading dataset...")
    instances = read_dataset(str(dataset_path))
    print(f"Found {len(instances)} instances")
    print()
    
    # Process instances in parallel
    max_workers = 32  # Number of parallel workers
    print(f"Processing with {max_workers} parallel workers...")
    print()
    
    success_count = 0
    failed_count = 0
    results = []
    
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit all tasks
        futures = {
            executor.submit(process_single_instance, instance, output_base, i, len(instances)): instance
            for i, instance in enumerate(instances, 1)
        }
        
        # Collect results as they complete
        for future in as_completed(futures):
            instance_id, success = future.result()
            results.append((instance_id, success))
            if success:
                success_count += 1
            else:
                failed_count += 1
    
    # Print summary
    print("\n" + "=" * 80)
    print("Summary")
    print("=" * 80)
    print(f"Total instances: {len(instances)}")
    print(f"Successfully extracted: {success_count}")
    print(f"Failed: {failed_count}")
    print(f"\nTests saved to: {output_base}")
    
    # Print failed instances
    if failed_count > 0:
        print("\nFailed instances:")
        for instance_id, success in results:
            if not success:
                print(f"  - {instance_id}")


if __name__ == '__main__':
    main()
