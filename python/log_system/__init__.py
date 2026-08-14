"""
@author: Azornes
@title: AzLogs
@version: 2.0.1
@description: Logging Initializer
"""

from .log_funcs import create_module_logger
from .logger import LogLevel, logger

__all__ = [
    "LogLevel",
    "create_module_logger",
    "logger",
]
