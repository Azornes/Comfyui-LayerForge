# This file makes the 'python' directory a package.
from . import log_system
from .log_system import logger

__all__ = ['log_system', 'logger']
